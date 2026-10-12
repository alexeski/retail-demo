import { Link } from 'react-router-dom'

export function Brand({ to, large = false }: { to: string; large?: boolean }) {
  return (
    <Link to={to} className={large ? 'brand is-large' : 'brand'}>
      <span className="brand-mark" aria-hidden>
        <span />
        <span />
        <span />
        <span />
      </span>
      <span className="brand-name">storeloom</span>
    </Link>
  )
}
