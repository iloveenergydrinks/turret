import "./technology-logos.css";

/** Technology integrations; these marks do not assert sponsorship or endorsement. */
export function TechnologyLogos() {
  return <section className="rusd-frame turret-technology" aria-label="Technology integrations">
    <p>Technology</p>
    <div className="turret-technology-logos">
      <a href="https://chain.link/" target="_blank" rel="noopener noreferrer" aria-label="Chainlink">
        <img className="turret-technology-chainlink" src="/brand/integrations/chainlink.svg" alt="Chainlink" width={84} height={21} loading="lazy" />
      </a>
      <a href="https://kyberswap.com/" target="_blank" rel="noopener noreferrer" aria-label="KyberSwap">
        <img className="turret-technology-kyber" src="/brand/integrations/kyberswap.svg" alt="KyberSwap" width={96} height={32} loading="lazy" />
      </a>
    </div>
  </section>;
}
