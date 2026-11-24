import type { Metadata } from "next";
import Link from "next/link";

import { LegalPage, type LegalSectionLink } from "#web/components/legal/LegalPage.tsx";

export const metadata: Metadata = {
  title: "Terms of Use",
  description: "The terms that apply to BLAST.FUN Mission Control, Season Zero, and the Blast interface.",
  alternates: { canonical: "/terms" },
};

const sections: LegalSectionLink[] = [
  { id: "agreement", label: "Agreement" },
  { id: "season-zero", label: "Season Zero" },
  { id: "about", label: "About Blast" },
  { id: "eligibility", label: "Eligibility" },
  { id: "noncustodial", label: "Non-custodial interface" },
  { id: "wallets", label: "Wallets and security" },
  { id: "transactions", label: "Transactions" },
  { id: "launches", label: "Token launches and content" },
  { id: "trading", label: "Trading and liquidity" },
  { id: "risks", label: "Risk disclosures" },
  { id: "fees", label: "Fees and taxes" },
  { id: "acceptable-use", label: "Acceptable use" },
  { id: "third-parties", label: "Third-party services" },
  { id: "intellectual-property", label: "Intellectual property" },
  { id: "submitted-content", label: "Submitted content" },
  { id: "availability", label: "Service availability" },
  { id: "warranties", label: "No warranties" },
  { id: "liability", label: "Limitation of liability" },
  { id: "indemnification", label: "Indemnification" },
  { id: "restriction", label: "Restriction and termination" },
  { id: "disputes", label: "Disputes" },
  { id: "general", label: "General terms" },
  { id: "changes", label: "Changes to these Terms" },
  { id: "contact", label: "Contact" },
];

const termsContent = (
  <>
      <section id="agreement">
        <h2>1. Agreement</h2>
        <p>
          These Terms of Use (“Terms”) are an agreement between you and the operator of BLAST.FUN (“Blast,” “we,”
          “us,” or “our”). They govern your access to and use of blast.fun, its subdomains, interfaces, features,
          APIs, content, and related services (together, the “Interface”).
        </p>
        <p>
          By accessing or using the Interface, connecting an identity or wallet, completing a Season Zero profile,
          creating a token, or submitting a transaction, you confirm that you have read and accepted these Terms
          and our <Link href="/privacy">Privacy Policy</Link>. If you do not agree, do not use the Interface.
        </p>
      </section>

      <section id="season-zero" data-disclosure-category="season-zero">
        <h2>1A. Season Zero</h2>
        <p>
          Mission Control is an invite-only preregistration experience. Completing the profile automatically joins
          Season Zero and associates your verified X identity snapshot, your full Sui wallet address, your callsign,
          fleet, crew assignment, card, and referral path with one Season Zero profile. The wallet may be an
          embedded Sui wallet created through Privy or an external Sui wallet connected through Slush.
        </p>
        <p>
          Callsign and fleet cannot currently be changed after profile completion. Mission Control also does not
          currently provide a self-service way to hide or delete a profile, merge profiles, unlink X, or replace the
          associated wallet. Clearing local browser data or disconnecting a provider does not alter the server-side
          Season Zero record.
        </p>
        <p>
          The owner of the launch code used to complete registration can see the completed recruit identity and
          crew assignment described in the Privacy Policy. Public callsign profile routes are currently disabled.
          If Blast enables them, the verified X handle and profile image, optional display name, callsign, full Sui
          wallet address, fleet, crew number and title, card, and completed-recruit total are intended to be public.
          Do not complete a profile if you do not want those fields associated in that way.
        </p>
        <p>
          Season Zero status, crew placement, cards, code allocation, completion progress, or other participation
          signals do not promise or guarantee any benefit. Blast may change or end Season Zero subject to these
          Terms and applicable law.
        </p>
      </section>

      <section id="about">
        <h2>2. About Blast</h2>
        <p>
          Blast provides software that helps users discover tokens and prepare interactions with public Sui
          blockchain networks, wallets, smart contracts, liquidity venues, and independent third-party services.
          The Interface may display public blockchain and market information and allow users to create, buy, sell,
          or otherwise interact with tokens from their own wallets.
        </p>
        <p>Questions about these Terms may be sent to <a href="mailto:hello@blast.fun">hello@blast.fun</a>.</p>
      </section>

      <section id="eligibility">
        <h2>3. Eligibility</h2>
        <p>To use the Interface, you represent and warrant that:</p>
        <ul>
          <li>You are at least 18 years old, or older if the age of legal majority where you live is higher, and have legal capacity to accept these Terms.</li>
          <li>If you use the Interface for an entity, you have authority to bind that entity to these Terms.</li>
          <li>Your use is lawful in every jurisdiction that applies to you, and you are responsible for determining and maintaining that compliance.</li>
          <li>You are not subject to applicable sanctions or restricted-party rules and are not using the Interface for or on behalf of a sanctioned or prohibited person or entity.</li>
          <li>You will not use the Interface where access or use would cause you, Blast, or another person to violate applicable law.</li>
        </ul>
        <p>
          We may restrict or discontinue access where we reasonably consider it necessary for legal, compliance,
          security, operational, or risk reasons. Availability in a location does not mean that use is lawful there.
        </p>
      </section>

      <section id="noncustodial">
        <h2>4. Non-custodial interface</h2>
        <p>
          Blast is a non-custodial software interface. We do not hold your assets or private keys, control your
          wallet, execute transactions on your behalf, guarantee settlement, or have the ability to reverse a
          blockchain transaction. Your wallet submits transactions directly to Sui and applicable smart contracts.
        </p>
        <p>
          Blast is not a bank, broker, exchange, custodian, investment adviser, fiduciary, money transmitter, or
          other financial institution. Nothing on the Interface is an offer or solicitation to buy or sell an
          investment, or investment, legal, accounting, or tax advice. Rankings, labels, trends, social signals,
          featured assets, and other displays are informational and are not endorsements or recommendations.
        </p>
      </section>

      <section id="wallets">
        <h2>5. Wallets and security</h2>
        <p>
          You are responsible for your wallet, private keys, recovery phrase, devices, authentication methods, and
          every action authorized through them. Blast will never ask for your private key or recovery phrase and
          cannot restore a wallet, recover assets, cancel approvals, or reverse transactions from a compromised
          wallet.
        </p>
        <p>
          For Mission Control, Privy may provide login, X connection, and an embedded Sui wallet, while Slush may
          provide the external-wallet connection. These providers are independent services with their own terms and
          security practices. Blast verifies a signed message to bind the Sui address to a Season Zero profile; a
          signature is not a transfer instruction, but you should still review it before signing.
        </p>
        <ul>
          <li>Use wallets and devices you trust and keep them secure.</li>
          <li>Verify the network, contract and token addresses, transaction details, amounts, recipients, permissions, fees, price impact, and slippage before signing.</li>
          <li>Treat unexpected wallet prompts, support messages, and links as potentially malicious.</li>
          <li>Notify us promptly if you suspect misuse of the Interface, but understand that we cannot control your wallet or public blockchain activity.</li>
        </ul>
      </section>

      <section id="transactions">
        <h2>6. Transactions</h2>
        <p>
          Every transaction is initiated and authorized through your wallet. Before signing, you are solely
          responsible for reviewing the transaction and understanding its effects. Smart contracts, Sui validators,
          and third-party protocols—not Blast—determine whether and how a transaction executes.
        </p>
        <p>
          Displayed quotes, prices, market capitalizations, balances, fees, simulations, outputs, price impact,
          slippage, transaction status, and completion times are estimates and may be delayed, incomplete,
          manipulated, or different from final execution. A transaction may fail, remain pending, be reordered,
          execute at an unexpected price, or be permanently irreversible.
        </p>
      </section>

      <section id="launches">
        <h2>7. Token launches and content</h2>
        <p>
          You are solely responsible for tokens you create, promote, or interact with and for names, symbols,
          descriptions, images, links, profiles, comments, and other content you submit (“User Content”). You
          represent and warrant that your User Content is accurate, lawful, not misleading, and that you hold all
          rights and permissions required to submit and use it.
        </p>
        <p>
          Token creation or appearance on the Interface does not mean that Blast has reviewed, audited, sponsored,
          endorsed, verified, or approved the token, its code, content, creator, holder distribution, or prospects.
          Anyone may create assets with similar names or symbols. Verify the package, object, and token identifiers
          before interacting. A pink “Known Deployer” helmet beside a token means only that someone at
          Blast checked who is behind it; it is not an endorsement, audit, or recommendation, says nothing about the
          token’s code, value, or prospects, and Blast may remove it at any time.
        </p>
        <p>
          You may not use the Interface to create or promote a token that infringes another person’s rights; is
          fraudulent, deceptive, abusive, or unlawful; impersonates another person or project; contains malware or
          malicious links; or constitutes an unlawful securities offering, pooled investment, ownership or debt
          interest, profit-sharing arrangement, or other regulated product.
        </p>
      </section>

      <section id="trading">
        <h2>8. Trading and liquidity</h2>
        <p>
          Tokens and liquidity positions available through the Interface may be experimental, unaudited, volatile,
          illiquid, malicious, or worthless. Blast does not guarantee token value, demand, liquidity, market depth,
          bonding-curve completion, migration or graduation, pool creation, order execution, counterparties, or the
          ability to sell or exit a position.
        </p>
        <p>
          Providing liquidity or interacting with bonding curves and liquidity pools can expose you to smart-contract
          risk, price movement, slippage, impermanent loss, partial execution, adverse selection, market
          manipulation, and loss of principal.
        </p>
      </section>

      <section id="risks">
        <h2>9. Risk disclosures</h2>
        <p>You understand and accept that:</p>
        <ul>
          <li>You may lose some or all assets used through the Interface.</li>
          <li>Smart contracts and software may contain defects, vulnerabilities, unexpected behavior, or malicious code, including after an audit.</li>
          <li>Creators, traders, validators, bots, or other third parties may act fraudulently, manipulate markets, abandon projects, or fail to perform promises.</li>
          <li>Sui, wallets, RPC services, indexers, bridges, oracles, decentralized storage, DEXs, and other dependencies may fail, change, become congested, be attacked, or become unavailable.</li>
          <li>Network upgrades, forks, reorganizations, validator conduct, governance decisions, and changes to third-party protocols may affect transactions and assets.</li>
          <li>Market and blockchain data may be inaccurate, incomplete, stale, or manipulated.</li>
          <li>Digital assets and your activities may be subject to changing legal, regulatory, tax, or accounting treatment.</li>
          <li>Public blockchain activity may reveal information about you and generally cannot be deleted.</li>
        </ul>
        <p>You are responsible for your own research, risk assessment, and decisions.</p>
      </section>

      <section id="fees">
        <h2>10. Fees and taxes</h2>
        <p>
          Transactions may incur network gas, launch, protocol, trading, liquidity, migration, price-impact,
          slippage, or third-party fees. Fees and estimates displayed before signing may differ from final amounts.
          By submitting a transaction, you authorize the fees encoded in that transaction.
        </p>
        <p>
          You are solely responsible for determining, reporting, and paying taxes, duties, and governmental charges
          arising from your use of the Interface or digital assets. Blast does not provide tax advice.
        </p>
      </section>

      <section id="acceptable-use">
        <h2>11. Acceptable use</h2>
        <p>You may not use the Interface to:</p>
        <ul>
          <li>Violate law, sanctions, intellectual-property rights, privacy rights, or another person’s rights.</li>
          <li>Defraud others, steal assets, launder funds, finance unlawful activity, evade legal restrictions, manipulate markets, or conceal proceeds of crime.</li>
          <li>Publish deceptive token metadata, false affiliations, spam, harassment, illegal content, malware, or malicious links.</li>
          <li>Interfere with the Interface, bypass access controls, exploit vulnerabilities, manipulate displayed data, evade rate limits, scrape abusively, or overload infrastructure.</li>
          <li>Use bots, scripts, or automated systems in a manner that violates law, these Terms, applicable third-party terms, or harms users or infrastructure.</li>
          <li>Probe, test, or access systems or data without authorization, except under an expressly authorized security program.</li>
        </ul>
        <p>
          We may investigate suspected misuse, preserve relevant records, cooperate with lawful requests, and hide or
          restrict off-chain content and access to product surfaces under our control.
        </p>
      </section>

      <section id="third-parties">
        <h2>12. Third-party services</h2>
        <p>
          The Interface relies on or links to independent wallets, Sui networks, smart contracts, RPC providers,
          indexers, explorers, decentralized exchanges, bridges, storage systems, market-data providers, websites,
          and other services. Blast does not control their availability, accuracy, security, code, conduct, fees,
          terms, or privacy practices.
        </p>
        <p>
          A link, integration, migration path, or displayed venue does not mean that Blast sponsors, controls, or
          endorses that third party. Your use of a third-party service is governed by its own terms and policies.
        </p>
        <p>
          Mission Control currently relies on Privy, X, Slush, Sui infrastructure, and hosting, database, and
          security providers for the roles described in the Privacy Policy. Availability or failure of one provider
          may limit login, wallet connection, identity verification, recovery, or other features.
        </p>
      </section>

      <section id="intellectual-property">
        <h2>13. Intellectual property</h2>
        <p>
          The Interface, BLAST.FUN branding, design, documentation, and original content are protected by
          intellectual-property laws. Subject to these Terms, Blast grants you a limited, revocable, nonexclusive,
          nontransferable right to access and use the Interface for lawful purposes. Open-source software remains
          governed by its applicable license.
        </p>
        <p>
          Except where separate terms or law permit it, you may not copy, modify, sell, sublicense, or create a
          competing commercial service from protected Blast materials without permission. You may send intellectual-
          property notices to <a href="mailto:hello@blast.fun">hello@blast.fun</a> with enough detail for us to
          identify the work, the challenged material, its location, your contact information, and your authority.
        </p>
      </section>

      <section id="submitted-content">
        <h2>14. Submitted content</h2>
        <p>
          You keep any rights you hold in User Content. You grant Blast a worldwide, nonexclusive, royalty-free,
          sublicensable license to host, store, reproduce, display, format, transmit, and moderate that content as
          reasonably necessary to operate, secure, improve, and promote the relevant Interface features.
        </p>
        <p>
          This license continues for content that remains on public blockchains, distributed storage, backups, or
          records reasonably retained for legal, compliance, or security purposes. Blast may hide, restrict, or
          remove off-chain User Content from surfaces under our control, but cannot remove content or transactions
          recorded on Sui or independent distributed storage.
        </p>
        <p>
          That operational ability is not a promise of a user-facing control. Mission Control does not currently
          offer self-service profile hiding or deletion, profile merging, X unlinking, or wallet replacement.
        </p>
        <p>If you provide feedback, you allow Blast to use it without restriction or compensation.</p>
      </section>

      <section id="availability">
        <h2>15. Service availability</h2>
        <p>
          Blast may add, modify, suspend, restrict, or discontinue any part of the Interface at any time. We do not
          guarantee continuous availability, compatibility with any wallet or network, preservation of off-chain
          data, or advance notice of changes. Independent smart contracts may remain accessible without the
          Interface, subject to their own operation and your technical ability.
        </p>
      </section>

      <section id="warranties">
        <h2>16. No warranties</h2>
        <p className="legal-caps">
          To the fullest extent permitted by law, the Interface is provided “as is” and “as available,” without
          warranties of any kind, express, implied, or statutory. Blast disclaims warranties of merchantability,
          fitness for a particular purpose, title, non-infringement, accuracy, availability, security, and
          uninterrupted operation.
        </p>
        <p>
          Blast does not warrant that tokens, creators, content, data, smart contracts, transactions, estimates, or
          third-party services are legitimate, accurate, complete, safe, current, or free from defects.
        </p>
      </section>

      <section id="liability">
        <h2>17. Limitation of liability</h2>
        <p className="legal-caps">
          To the fullest extent permitted by law, Blast and its affiliates, contributors, officers, directors,
          employees, agents, and service providers will not be liable for indirect, incidental, special,
          consequential, exemplary, or punitive damages; lost profits, revenue, data, goodwill, or assets; failed,
          delayed, or unexpected transactions; smart-contract defects; wallet compromise; network events; price
          movement; market manipulation; or third-party conduct arising from or related to the Interface.
        </p>
        <p>
          To the fullest extent permitted by law, their total aggregate liability for all claims arising from or
          relating to the Interface will not exceed the greater of (a) fees you paid directly to Blast for use of the
          Interface during the twelve months before the event giving rise to the claim or (b) one hundred U.S.
          dollars. Some jurisdictions do not allow certain exclusions or limitations; in those jurisdictions,
          liability is limited only to the extent permitted by law.
        </p>
      </section>

      <section id="indemnification">
        <h2>18. Indemnification</h2>
        <p>
          To the fullest extent permitted by law, you agree to defend, indemnify, and hold harmless Blast and its
          affiliates, contributors, officers, directors, employees, agents, and service providers from claims,
          losses, liabilities, damages, judgments, costs, and reasonable legal fees arising from your use of the
          Interface, your User Content or token, your violation of these Terms, or your violation of law or another
          person’s rights.
        </p>
      </section>

      <section id="restriction">
        <h2>19. Restriction and termination</h2>
        <p>
          We may suspend, restrict, or terminate access to off-chain Interface features, with or without notice,
          including where we reasonably suspect fraud, market manipulation, sanctions or legal risk, a security
          threat, automated abuse, or a violation of these Terms. We cannot prevent you from interacting directly
          with public, permissionless smart contracts, but those interactions remain at your sole risk.
        </p>
        <p>
          Provisions that by their nature should survive termination—including those concerning risks, fees, taxes,
          intellectual property, licenses, disclaimers, liability, indemnification, disputes, and general terms—will
          survive.
        </p>
      </section>

      <section id="disputes">
        <h2>20. Disputes</h2>
        <p>
          Before starting a formal claim relating to the Interface, you agree to email
          {" "}<a href="mailto:hello@blast.fun">hello@blast.fun</a> with a reasonable description of the dispute
          and requested resolution. You and Blast will attempt in good faith to resolve it informally for at least
          thirty days. If it is not resolved, either party may bring the claim in a court of competent jurisdiction,
          subject to any mandatory rights and procedures under applicable law.
        </p>
      </section>

      <section id="general">
        <h2>21. General terms</h2>
        <p>
          If any provision of these Terms is found unenforceable, it will be enforced to the maximum extent allowed
          and the remaining provisions will continue in effect. A failure to enforce a provision is not a waiver.
          Headings are for convenience only. You may not assign these Terms without our consent; Blast may assign
          them in connection with a merger, acquisition, reorganization, asset transfer, or operation of the
          Services.
        </p>
        <p>
          These Terms and the Privacy Policy are the entire agreement between you and Blast concerning the
          Interface, except where additional terms are presented for a specific feature. They do not create any
          partnership, joint venture, employment, agency, or fiduciary relationship.
        </p>
      </section>

      <section id="changes">
        <h2>22. Changes to these Terms</h2>
        <p>
          We may update these Terms as the Interface, risks, or legal requirements change. The effective date at the
          top identifies the current version. Material changes may be communicated through the Interface or another
          appropriate channel. Continued use after revised Terms take effect means you accept the revised Terms for
          later activity. If you do not agree, stop using the Interface.
        </p>
      </section>

      <section id="contact">
        <h2>23. Contact</h2>
        <p>Questions about these Terms may be sent to BLAST.FUN at <a href="mailto:hello@blast.fun">hello@blast.fun</a>.</p>
      </section>
  </>
);

export default function TermsPage() {
  return (
    <LegalPage
      current="terms"
      title="Terms of Use"
      description="These Terms govern Mission Control, Season Zero, and the BLAST.FUN interface for interacting with products on Sui."
      effectiveDate="2026-09-25"
      sections={sections}
      notice={(
        <>
          <strong>Risk warning.</strong> Digital assets, especially newly created and community tokens, are highly
          volatile and may lose all value. Transactions may be irreversible. Blast does not provide investment,
          legal, tax, or financial advice. Use only assets you can afford to lose.
        </>
      )}
    >
      {termsContent}
    </LegalPage>
  );
}
