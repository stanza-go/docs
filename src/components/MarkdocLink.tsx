import Link from 'next/link'

export function MarkdocLink({
  href,
  children,
  ...rest
}: {
  href: string
  children: React.ReactNode
  [key: string]: any
}) {
  if (href.startsWith('/') || href.startsWith('#')) {
    return (
      <Link href={href} {...rest}>
        {children}
      </Link>
    )
  }

  return (
    <a href={href} {...rest}>
      {children}
    </a>
  )
}
