const portfolio = "/portfolio";

export const SOCIAL_PAGE_PATHS = {
  home: "/",
  feed: "/feed",
  presales: "/presale",
  notifications: "/notifications",
  portfolio,
  portfolioPresales: `${portfolio}/presales`,
  portfolioClaims: `${portfolio}/claims`,
  portfolioLaunches: `${portfolio}/launches`,
  portfolioRewards: `${portfolio}/rewards`,
  portfolioVestings: `${portfolio}/vestings`,
  invites: "/invites",
  settings: "/settings",
  signIn: "/sign-in",
  create: "/create",
  launch: "/launch",
  bonding: "/bonding",
  coin: "/coin",
} as const;
