# Proposal: bring coins in from other chains

For Jose. 2026-11-26. Full plan: `mayan-bridge-in.md` beside this file.

## Goal

Someone has 0.01 ETH on Base. Today they must find a bridge, copy their Blast
address and hope. With this, they tap Bridge in Blast (beside Deposit
and Withdraw), pick Base and ETH, type the amount, connect their wallet and sign.
Seconds later (Mayan quotes about 10 s from Base) the SUI is in their Blast
wallet and the balance updates on its own.

First release: ETH or SOL, and USDC, from Base, Ethereum, Arbitrum and Solana.
Second release: any token Mayan lists on those chains (BONK and others). They
receive SUI or USDC.

Success: a $2 bridge from Base and from Solana lands in a Blast wallet on the
live site, with no reload.

## Implementation

- Our own card, built on Mayan's code library. No Mayan widget, no outside
  script, no change to our script security rules.
- The coins always go to the person's own Blast wallet. They cannot type
  another address. Before the wallet signs, the app reads Mayan's order and
  stops unless it pays their Blast wallet and refunds to their own wallet.
- They connect their Base or Solana wallet through Privy. This is new for
  signed-in people; it does not change their Blast sign-in.
- Prices come from Mayan straight to the browser, a short pause after typing.
  Our servers do no work per keystroke. When coins arrive, the app re-reads
  the person's wallet and portfolio once.
- "Recent bridges" under the card comes from Mayan's public tracker, so a
  bridge still shows after a reload. No new database.
- Hidden behind a switch until the team has tested it live.
- Fee: 0%. You ruled this on 2026-11-26.

Tested today with no money moved: real prices from Base, Ethereum, Arbitrum
and Solana into Sui (0.01 ETH → about 25 SUI), and the transactions build.
BSC has no route to Sui today, so it is left out until it does.

## Review

- Automatic tests for every screen state: signed out, no wallet, wrong
  network, price loading, no route, not enough balance, approve, sign, on the
  way, arrived, refunded, wallet rejected, price changed.
- Tests that stop any order not paying the Blast wallet.
- Screenshots of every state on phone and desktop, light and dark, scored on
  the five design principles.
- Live: the team bridges $2 from Base, $2 from Solana, and $2 of Base USDC to
  cover the approval step.

## Decisions for you

1. Placement: ruled 2026-11-26, its own Bridge button beside Deposit and
   Withdraw.
2. Fee: ruled 2026-11-26, 0%.
3. Approve the plan so the build can start.
