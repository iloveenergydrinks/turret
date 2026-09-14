import type { ReactNode } from "react";
import "./empty-state.css";

/** Use only after a completed read. Loading and failed reads must stay explicit. */
export function EmptyState({ title, description, actions, children, illustration = true, heading = "h3", id }: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children?: ReactNode;
  illustration?: boolean;
  heading?: "h2" | "h3";
  id?: string;
}) {
  const Heading = heading;
  return <div className="turret-empty">
    {illustration && <img className="turret-empty-art" src="/illustrations/turret-open-door-v1.webp"
      alt="" aria-hidden="true" width={112} height={75} loading="lazy" decoding="async" />}
    <div className="turret-empty-content">
      <Heading className="turret-empty-title" id={id}>{title}</Heading>
      {description && <p className="turret-empty-description">{description}</p>}
      {actions && <div className="turret-empty-actions">{actions}</div>}
      {children}
    </div>
  </div>;
}
