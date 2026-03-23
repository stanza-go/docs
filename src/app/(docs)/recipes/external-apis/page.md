---
title: External API integration
nextjs:
  metadata:
    title: External API integration
    description: How to call external APIs from your handlers — HTTP requests, streaming responses, proxying SSE, and error handling.
---

Stanza apps often need to call external APIs — AI providers (OpenRouter, Anthropic, OpenAI), payment processors, notification services, or any third-party HTTP endpoint. This recipe covers the patterns for making outbound HTTP requests, streaming responses back to clients, and handling failures.

---

## HTTP client setup

Use Go's standard `net/http` client with explicit timeouts. Never use `http.DefaultClient` in production — it has no timeout.

```go
var apiClient = &nethttp.Client{
    Timeout: 30 * time.Second,
}
```

For long-running streaming requests where the response body streams over time, set the timeout on the request context instead of the client:

```go
// Streaming client — no overall timeout (context controls cancellation)
var streamClient = &nethttp.Client{
    Timeout: 0,
}
```

---

## Making a JSON request

The most common pattern — send JSON, receive JSON:

```go
func callExternalAPI(ctx context.Context, apiKey, prompt string) (string, error) {
    payload, _ := json.Marshal(map[string]any{
        "model":  "anthropic/claude-sonnet-4-20250514",
        "messages": []map[string]string{
            {"role": "user", "content": prompt},
        },
    })

    req, err := nethttp.NewRequestWithContext(ctx, "POST", "https://openrouter.ai/api/v1/chat/completions", bytes.NewReader(payload))
    if err != nil {
        return "", err
    }
    req.Header.Set("Content-Type", "application/json")
    req.Header.Set("Authorization", "Bearer "+apiKey)

    resp, err := apiClient.Do(req)
    if err != nil {
        return "", err
    }
    defer resp.Body.Close()

    if resp.StatusCode != nethttp.StatusOK {
        body, _ := io.ReadAll(resp.Body)
        return "", fmt.Errorf("api error %d: %s", resp.StatusCode, body)
    }

    var result struct {
        Choices []struct {
            Message struct {
                Content string `json:"content"`
            } `json:"message"`
        } `json:"choices"`
    }
    if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
        return "", err
    }
    if len(result.Choices) == 0 {
        return "", fmt.Errorf("no response from api")
    }

    return result.Choices[0].Message.Content, nil
}
```

Key points:

- **Always use `NewRequestWithContext`.** The context carries the client's cancellation — if the user disconnects, the outbound request is cancelled too.
- **Always `defer resp.Body.Close()`.** Leaking bodies exhausts connection pools.
- **Read the full body on error.** The error message from the API is often in the response body, not the status code.

---

## Using it in a handler

Wire the external call into a route handler, passing the request context:

```go
func (m *Module) chatHandler(w http.ResponseWriter, r *http.Request) {
    var body struct {
        Message string `json:"message"`
    }
    if err := http.ReadJSON(r, &body); err != nil {
        http.WriteError(w, http.StatusBadRequest, "invalid request body")
        return
    }

    // Pass r.Context() — cancels the API call if the client disconnects
    reply, err := callExternalAPI(r.Context(), m.apiKey, body.Message)
    if err != nil {
        log.Error("external api call failed", "error", err)
        http.WriteError(w, http.StatusBadGateway, "upstream service unavailable")
        return
    }

    http.WriteJSON(w, http.StatusOK, map[string]any{
        "reply": reply,
    })
}
```

Return `502 Bad Gateway` (not 500) when the external API fails — it tells the caller the error is upstream, not in your code.

---

## Streaming responses (SSE proxy)

Many AI APIs stream responses as Server-Sent Events. To forward these to the client in real-time, consume the upstream SSE stream and re-emit events using the framework's `SSEWriter`:

```go
func (m *Module) streamHandler(w http.ResponseWriter, r *http.Request) {
    var body struct {
        Message string `json:"message"`
    }
    if err := http.ReadJSON(r, &body); err != nil {
        http.WriteError(w, http.StatusBadRequest, "invalid request body")
        return
    }

    payload, _ := json.Marshal(map[string]any{
        "model":  "anthropic/claude-sonnet-4-20250514",
        "stream": true,
        "messages": []map[string]string{
            {"role": "user", "content": body.Message},
        },
    })

    req, err := nethttp.NewRequestWithContext(r.Context(), "POST",
        "https://openrouter.ai/api/v1/chat/completions",
        bytes.NewReader(payload))
    if err != nil {
        http.WriteError(w, http.StatusInternalServerError, "failed to create request")
        return
    }
    req.Header.Set("Content-Type", "application/json")
    req.Header.Set("Authorization", "Bearer "+m.apiKey)

    resp, err := streamClient.Do(req)
    if err != nil {
        http.WriteError(w, http.StatusBadGateway, "upstream connection failed")
        return
    }
    defer resp.Body.Close()

    if resp.StatusCode != nethttp.StatusOK {
        errBody, _ := io.ReadAll(resp.Body)
        http.WriteError(w, http.StatusBadGateway,
            fmt.Sprintf("upstream error %d: %s", resp.StatusCode, errBody))
        return
    }

    // Start SSE stream to client
    sse := http.NewSSEWriter(w)

    // Read upstream SSE line by line
    scanner := bufio.NewScanner(resp.Body)
    for scanner.Scan() {
        line := scanner.Text()

        // SSE lines starting with "data: " carry the payload
        if !strings.HasPrefix(line, "data: ") {
            continue
        }
        data := strings.TrimPrefix(line, "data: ")

        // "[DONE]" signals end of stream
        if data == "[DONE]" {
            sse.Event("done", "")
            return
        }

        // Parse the chunk to extract the content delta
        var chunk struct {
            Choices []struct {
                Delta struct {
                    Content string `json:"content"`
                } `json:"delta"`
            } `json:"choices"`
        }
        if err := json.Unmarshal([]byte(data), &chunk); err != nil {
            continue
        }
        if len(chunk.Choices) > 0 && chunk.Choices[0].Delta.Content != "" {
            sse.Event("chunk", chunk.Choices[0].Delta.Content)
        }
    }
}
```

How this works:

1. **Upstream connection.** Send the request with `stream: true` to the AI provider.
2. **SSE bridge.** Create an `SSEWriter` for the client, then scan the upstream response line by line.
3. **Parse and re-emit.** Extract the content delta from each SSE chunk and forward it as a named event.
4. **Cancellation.** The request context (`r.Context()`) propagates to the upstream request — if the client disconnects, the upstream call is cancelled automatically.

---

## Background processing with queue

For long-running API calls (document analysis, image generation), process them asynchronously via the job queue instead of blocking the HTTP request:

```go
// Handler — enqueue the job
func (m *Module) generateHandler(w http.ResponseWriter, r *http.Request) {
    var body struct {
        Prompt string `json:"prompt"`
    }
    if err := http.ReadJSON(r, &body); err != nil {
        http.WriteError(w, http.StatusBadRequest, "invalid request body")
        return
    }

    claims, _ := auth.ClaimsFromContext(r.Context())
    payload, _ := json.Marshal(map[string]string{
        "user_id": claims.UID,
        "prompt":  body.Prompt,
    })

    jobID, err := m.queue.Dispatch("generate_image", string(payload))
    if err != nil {
        http.WriteError(w, http.StatusInternalServerError, "failed to queue job")
        return
    }

    http.WriteJSON(w, http.StatusAccepted, map[string]any{
        "job_id": jobID,
        "status": "queued",
    })
}

// Worker — process the job
func (m *Module) processGeneration(ctx context.Context, payload string) error {
    var data struct {
        UserID string `json:"user_id"`
        Prompt string `json:"prompt"`
    }
    json.Unmarshal([]byte(payload), &data)

    result, err := callExternalAPI(ctx, m.apiKey, data.Prompt)
    if err != nil {
        return err // Job will be retried
    }

    // Store the result
    sqlite.Insert("generations").
        Set("user_id", data.UserID).
        Set("prompt", data.Prompt).
        Set("result", result).
        Exec(m.db)

    return nil
}
```

The queue handles retries automatically — if the external API returns a transient error, the job is retried with backoff.

---

## Error handling patterns

External APIs fail in predictable ways. Handle each:

```go
func callWithRetry(ctx context.Context, apiKey, prompt string) (string, error) {
    resp, err := apiClient.Do(req)
    if err != nil {
        // Network error — connection refused, DNS failure, timeout
        return "", fmt.Errorf("network error: %w", err)
    }
    defer resp.Body.Close()

    switch {
    case resp.StatusCode == 429:
        // Rate limited — read Retry-After header
        retryAfter := resp.Header.Get("Retry-After")
        return "", fmt.Errorf("rate limited, retry after %s", retryAfter)

    case resp.StatusCode == 401 || resp.StatusCode == 403:
        // Auth error — bad API key, don't retry
        return "", fmt.Errorf("authentication failed: check api key")

    case resp.StatusCode >= 500:
        // Upstream server error — transient, safe to retry
        body, _ := io.ReadAll(resp.Body)
        return "", fmt.Errorf("upstream error %d: %s", resp.StatusCode, body)

    case resp.StatusCode != 200:
        // Client error (4xx) — bad request, don't retry
        body, _ := io.ReadAll(resp.Body)
        return "", fmt.Errorf("api error %d: %s", resp.StatusCode, body)
    }

    // Success — decode response
    // ...
}
```

| Status | Meaning | Retry? |
|--------|---------|--------|
| 200 | Success | — |
| 401, 403 | Auth failure | No — fix the API key |
| 429 | Rate limited | Yes — respect `Retry-After` |
| 5xx | Server error | Yes — transient failure |
| Other 4xx | Bad request | No — fix the request |

---

## Storing API keys

Store external API keys as app settings in SQLite, not in environment variables or config files:

```go
// Read API key from settings
var apiKey string
sqlite.Select("value").
    From("settings").
    Where("key = ?", "openrouter_api_key").
    QueryRow(db, &apiKey)
```

This lets admins update API keys through the admin panel without redeploying. For secrets that must be set before the app starts, use environment variables via the config package.

---

## Rate limiting outbound calls

If your users trigger external API calls, rate-limit at your API layer to control costs:

```go
func (m *Module) chatHandler(w http.ResponseWriter, r *http.Request) {
    claims, _ := auth.ClaimsFromContext(r.Context())

    // Count requests in the current window
    var count int
    sqlite.Select("COUNT(*)").
        From("chat_messages").
        Where("user_id = ?", claims.UID).
        Where("created_at > datetime('now', '-1 day')").
        QueryRow(m.db, &count)

    if count >= m.dailyLimit {
        http.WriteError(w, http.StatusTooManyRequests,
            fmt.Sprintf("daily limit reached (%d messages per day)", m.dailyLimit))
        return
    }

    // Proceed with API call...
}
```

---

## Tips

- **Never use `http.DefaultClient`.** It has no timeout — a hung external API will hold your goroutine forever.
- **Pass `r.Context()` to outbound requests.** Client disconnect → upstream request cancelled → no wasted API credits.
- **Return 502 for upstream failures.** Tells the caller the problem is external, not your code.
- **Use the job queue for slow calls.** If the external API takes more than a few seconds, queue the work and let the client poll for results.
- **Log external errors with the response body.** The upstream error message is in the body, not the status code. Read and log it before returning an error to the client.
- **Set `stream: true` only when proxying.** If you're storing the full result (not streaming to the client), use non-streaming mode — it's simpler and you get the complete response in one JSON decode.
