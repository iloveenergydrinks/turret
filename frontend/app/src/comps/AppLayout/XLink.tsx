import styles from "./XLink.module.css";

export function XLink() {
  return (
    <a
      aria-label="Turret on X (opens in a new tab)"
      className={styles.link}
      href="https://x.com/turret_capital"
      rel="noopener noreferrer"
      target="_blank"
      title="@turret_capital on X"
    >
      <svg aria-hidden="true" fill="currentColor" height="18" viewBox="0 0 24 24" width="18">
        <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.64 7.584H.47l8.6-9.835L0 1.154h7.594l5.243 6.932 6.064-6.933Zm-1.29 19.49h2.039L6.487 3.24H4.3l13.311 17.403Z" />
      </svg>
    </a>
  );
}
