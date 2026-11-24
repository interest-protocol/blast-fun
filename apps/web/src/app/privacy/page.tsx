import type { Metadata } from "next";

import { LegalPage, type LegalSectionLink } from "#web/components/legal/LegalPage.tsx";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How BLAST.FUN collects, uses, shares, and protects information.",
  alternates: { canonical: "/privacy" },
};

const sections: LegalSectionLink[] = [
  { id: "scope", label: "Scope and who we are" },
  { id: "information", label: "Information we collect" },
  { id: "season-zero", label: "Season Zero preregistration" },
  { id: "sources", label: "Sources of information" },
  { id: "use", label: "How we use information" },
  { id: "legal-bases", label: "Legal bases" },
  { id: "blockchain", label: "Public blockchain data" },
  { id: "disclosure", label: "How we disclose information" },
  { id: "storage", label: "Cookies and browser storage" },
  { id: "retention", label: "Retention" },
  { id: "security", label: "Security" },
  { id: "international", label: "International processing" },
  { id: "rights", label: "Your rights and choices" },
  { id: "us-disclosures", label: "United States disclosures" },
  { id: "children", label: "Children" },
  { id: "changes", label: "Changes to this policy" },
  { id: "contact", label: "Contact" },
];

export default function PrivacyPage() {
  return (
    <LegalPage
      current="privacy"
      title="Privacy Policy"
      description="This policy explains how BLAST.FUN handles information when you use Mission Control, join Season Zero, connect a wallet, or otherwise use the Blast interface."
      effectiveDate="2026-09-25"
      sections={sections}
    >
      <section id="scope">
        <h2>1. Scope and who we are</h2>
        <p>
          This Privacy Policy applies to the website at blast.fun, its subdomains, and the interfaces, features,
          content, and support channels that link to this policy (together, the “Services”). The Services are
          operated under the BLAST.FUN name (“Blast,” “we,” “us,” or “our”). For questions or privacy requests,
          contact <a href="mailto:hello@blast.fun">hello@blast.fun</a>.
        </p>
        <p>
          Mission Control is Blast&apos;s Season Zero preregistration experience. Blast may also provide a
          non-custodial interface for discovering, creating, and interacting with tokens and smart contracts on
          Sui. This policy covers information processed through Services under our control. It does not cover the
          Sui network, independent wallets, X, Privy, Slush, decentralized protocols, exchanges, websites, or other
          third-party services, which have their own practices and policies.
        </p>
      </section>

      <section id="information">
        <h2>2. Information we collect</h2>
        <p>The information we collect depends on how you use the Services and may include:</p>
        <ul>
          <li><strong>Wallet and blockchain information.</strong> Public wallet addresses, wallet connection status, signatures used to authenticate or authorize requests, transaction digests, token balances, smart-contract interactions, trading activity, liquidity positions, and other public on-chain data.</li>
          <li><strong>Season Zero identity.</strong> Your Privy account identifier; a verified X account identifier and snapshot of its handle, display name, and profile image; the full Sui wallet address created through Privy or connected through Slush; and provider wallet references.</li>
          <li><strong>Season Zero profile and referral information.</strong> Your callsign, optional display name, fleet and crew assignment, title and card record, disclosure acceptance, the launch code used to join, its code owner, and completed recruits attributed to your codes.</li>
          <li><strong>Content you submit.</strong> Token names, symbols, descriptions, images, links, creator or profile information, comments, watchlists, and other information you choose to make available through the Services.</li>
          <li><strong>Communications.</strong> Your email address and the contents of messages you send to support or other Blast channels.</li>
          <li><strong>Device, network, and usage information.</strong> IP address, approximate location derived from IP address, browser and device type, operating system, language, referring page, pages or features requested, request time, performance data, and diagnostic or security events.</li>
          <li><strong>Local preferences and session data.</strong> Interface preferences, watchlists, display and sound settings, wallet session state, and similar data stored through your browser or wallet tools.</li>
          <li><strong>Compliance information.</strong> If required by law or to protect the Services, we may collect information reasonably necessary to assess sanctions, fraud, security, or other legal and compliance risks.</li>
        </ul>
        <p>We do not ask for, collect, or have access to your private keys or wallet recovery phrase.</p>
      </section>

      <section id="season-zero" data-disclosure-category="season-zero">
        <h2>2A. Season Zero preregistration</h2>
        <p>
          Completing a Mission Control profile joins Season Zero. X verification supplies the identity snapshot
          used for the profile and card. Every completed profile ends with one full Sui wallet address: either an
          embedded wallet created through Privy or a wallet connected through Slush. Blast stores the association
          among that wallet, the verified X identity, the profile, and the code path used to join.
        </p>
        <p>
          Public profile routes are currently disabled. If Blast enables them, the planned public Season Zero
          projection includes the verified X handle and profile image, optional display name, callsign, full Sui
          wallet address, fleet, crew number and title, card, and completed-recruit total. A public shared-card
          image also displays up to five recent recruits&apos; verified X handles. The private Privy
          identifier, provider wallet reference, X subject identifier, the launch code itself, and private
          onboarding answers are not part of that public projection.
        </p>
        <p>
          If you request the two-code X engagement reward, Blast asks X to confirm that the X account connected
          to your profile follows <strong>@blastdotfun</strong>. Blast stores the successful follow-verification
          time and issues two codes once. Sharing your card is optional; no public post link or post verification
          is required for this reward. Follow checks use Blast’s app credentials, not a stored member access token.
        </p>
        <p>
          The owner of the code used to complete a profile can see that a recruit completed registration and the
          recruit identity needed for the crew list: callsign, optional display name, verified X handle and profile
          image, fleet, and crew number. Blast does not expose the recruit&apos;s login credentials, provider
          identifiers, launch code, or private onboarding answers to the code owner.
        </p>
        <p>
          Callsign and fleet are fixed for Season Zero after profile completion. There is currently no self-service
          control to hide or delete a Season Zero profile, merge profiles, unlink X, or change the wallet associated
          with the profile. Contacting support is not a guarantee that Blast can make a requested change; applicable
          legal rights and required exceptions are assessed case by case.
        </p>
      </section>

      <section id="sources">
        <h2>3. Sources of information</h2>
        <p>
          We receive information directly from you; automatically from your browser, device, or wallet; from
          public Sui blockchain records; and from providers that support the Services. For Season Zero, Privy
          supports login, X identity connection, and embedded-wallet creation; Slush supports an external Sui
          wallet connection; X supplies the verified identity snapshot; and hosting, database, security, Sui RPC,
          and related infrastructure providers process information needed to operate and protect Mission Control.
          Those providers act under their own terms, our instructions, or both, depending on the service.
        </p>
      </section>

      <section id="use">
        <h2>4. How we use information</h2>
        <ul>
          <li>Provide, maintain, and improve token discovery, launch, trading, liquidity, wallet, profile, portfolio, and community features.</li>
          <li>Connect wallets, verify signatures, prepare transaction requests, and display public on-chain activity.</li>
          <li>Process content you submit and operate public product surfaces.</li>
          <li>Respond to questions, support requests, disputes, and other communications.</li>
          <li>Measure performance, understand feature use, diagnose failures, and develop new features.</li>
          <li>Detect and address spam, fraud, malware, market abuse, security threats, and other prohibited conduct.</li>
          <li>Comply with legal obligations, respond to lawful requests, resolve disputes, and enforce our Terms of Use.</li>
          <li>Protect the rights, safety, and integrity of Blast, our users, service providers, and the public.</li>
        </ul>
      </section>

      <section id="legal-bases">
        <h2>5. Legal bases</h2>
        <p>
          Where applicable law requires a legal basis, we process information as necessary to provide Services you
          request or perform an agreement with you; for our legitimate interests in operating, securing, and
          improving the Services; with your consent where requested; and to comply with legal obligations. Where we
          rely on consent, you may withdraw it at any time, without affecting processing already completed.
        </p>
      </section>

      <section id="blockchain">
        <h2>6. Public blockchain data</h2>
        <p>
          Sui is a public blockchain. Wallet addresses, transactions, token activity, smart-contract events, and
          related records may be public, permanent, and available through independent nodes, indexers, explorers,
          analytics providers, and other services. A public wallet address or transaction can be personal
          information when it can be linked to an identifiable person.
        </p>
        <p>
          Blast cannot edit, hide, reverse, or delete information recorded on Sui or another independent public
          network. Disconnecting a wallet, deleting local browser data, or making a privacy request does not remove
          prior public on-chain activity.
        </p>
      </section>

      <section id="disclosure">
        <h2>7. How we disclose information</h2>
        <p>We may disclose information in the following circumstances:</p>
        <ul>
          <li><strong>Service providers.</strong> To providers supporting hosting, content delivery, security, wallet connectivity, blockchain access, indexing, storage, analytics, support, and market data, subject to their applicable terms or our instructions.</li>
          <li><strong>Season Zero and public features.</strong> The code owner can see the completed recruit identity described in Section 2A. Public Season Zero profile routes are disabled at the effective date; if enabled, the fields listed in Section 2A will be visible to anyone. Token metadata, profile content, comments, or on-chain activity published through other features may also be public.</li>
          <li><strong>Legal and safety purposes.</strong> When reasonably necessary to comply with law or a lawful request, enforce our agreements, investigate abuse, or protect rights, safety, assets, and service integrity.</li>
          <li><strong>Business transfers.</strong> In connection with a proposed or completed merger, financing, acquisition, reorganization, sale of assets, or similar transaction, subject to appropriate safeguards.</li>
          <li><strong>At your direction.</strong> When you request or authorize a disclosure, including by connecting to or using a third-party integration.</li>
        </ul>
        <p>
          We do not sell personal information or share personal information for cross-context behavioral
          advertising. Blast does not use personal information for targeted advertising.
        </p>
      </section>

      <section id="storage">
        <h2>8. Cookies and browser storage</h2>
        <p>
          Blast and providers supporting wallet connectivity, infrastructure, and security may use local storage,
          session storage, cookies, or similar browser technologies to maintain wallet sessions, remember settings
          and watchlists, preserve feature state, prevent abuse, diagnose problems, and measure performance.
        </p>
        <p>
          You can disconnect your wallet, clear site data, or adjust browser and wallet controls. Doing so may sign
          you out, remove saved preferences, or prevent some features from working. At the effective date of this
          policy, Blast does not use advertising cookies.
        </p>
      </section>

      <section id="retention">
        <h2>9. Retention</h2>
        <p>
          We retain off-chain information only for as long as reasonably necessary for the purposes described in
          this policy, including providing public product surfaces, maintaining security, resolving disputes,
          enforcing agreements, and meeting legal, tax, accounting, or reporting requirements. Retention varies by
          the type and purpose of the information. We may delete or de-identify information when it is no longer
          needed. Public blockchain and distributed-storage records may persist indefinitely outside our control.
        </p>
        <p>
          Season Zero profile, identity-link, wallet-link, code-attribution, disclosure, and security records are
          retained while needed to operate Season Zero, preserve crew and referral integrity, prevent duplicate or
          abusive registrations, secure access, and satisfy applicable obligations. Because callsign, fleet, crew,
          and referral relationships define the campaign record, clearing a browser or disconnecting a provider
          does not remove those server records.
        </p>
      </section>

      <section id="security">
        <h2>10. Security</h2>
        <p>
          We use reasonable administrative and technical safeguards designed to protect systems and information
          under our control. No internet service, wallet, smart contract, blockchain, or storage system can be
          guaranteed completely secure. Protect your devices and wallet credentials, review every wallet request,
          and never send us a private key, recovery phrase, or password.
        </p>
      </section>

      <section id="international">
        <h2>11. International processing</h2>
        <p>
          Blast and its service providers may process information in countries other than the country where you
          live. Those countries may have different data-protection laws. Where required, we use appropriate
          safeguards for international transfers of personal information.
        </p>
      </section>

      <section id="rights">
        <h2>12. Your rights and choices</h2>
        <p>
          Depending on where you live, you may have rights to access, correct, delete, or obtain a copy of personal
          information; object to or restrict certain processing; withdraw consent; appeal a denied request; or
          complain to a data-protection authority. These rights may be limited by exceptions under applicable law,
          and we cannot alter public blockchain records.
        </p>
        <ul>
          <li>Use public areas without connecting a wallet where a connection is not required.</li>
          <li>Disconnect your wallet and manage wallet permissions.</li>
          <li>Clear local browser storage or change browser controls.</li>
          <li>Avoid placing personal information in token metadata, links, profiles, or comments intended for public display.</li>
          <li>Email <a href="mailto:hello@blast.fun">hello@blast.fun</a> to make a request. Describe the request and provide the wallet address, email address, or other details reasonably needed to locate the relevant records. We may verify your identity or authority before responding.</li>
        </ul>
        <p>
          Mission Control does not currently provide self-service hide, delete, profile-merge, X-unlink, or
          wallet-change controls. Privacy requests sent to support are handled under applicable law and may be
          limited by identity verification, security, fraud-prevention, recordkeeping, public-blockchain, or other
          lawful exceptions.
        </p>
        <p>We will not discriminate against you for exercising an applicable privacy right.</p>
      </section>

      <section id="us-disclosures">
        <h2>13. United States disclosures</h2>
        <p>
          Blast does not sell personal information or share it for cross-context behavioral advertising. We do not
          knowingly use or disclose sensitive personal information for purposes that require a right to limit under
          applicable U.S. state privacy laws. Residents of certain states may have rights to know, access, correct,
          delete, or obtain a copy of personal information, and to appeal a denied request. Submit requests using
          the contact details below.
        </p>
      </section>

      <section id="children">
        <h2>14. Children</h2>
        <p>
          The Services are not directed to children, and you must be at least 18 years old—or older if the age of
          legal majority where you live is higher—to use them. We do not knowingly collect personal information
          from anyone who does not meet this requirement. Contact us if you believe a child has provided personal
          information through the Services.
        </p>
      </section>

      <section id="changes">
        <h2>15. Changes to this policy</h2>
        <p>
          We may update this policy as the Services, infrastructure, or legal requirements change. The date at the
          top identifies the current version. When required by law, we will provide additional notice of material
          changes through the Services or another appropriate channel.
        </p>
      </section>

      <section id="contact">
        <h2>16. Contact</h2>
        <p>
          Questions, requests, and complaints about privacy may be sent to BLAST.FUN at
          {" "}<a href="mailto:hello@blast.fun">hello@blast.fun</a>.
        </p>
      </section>
    </LegalPage>
  );
}
