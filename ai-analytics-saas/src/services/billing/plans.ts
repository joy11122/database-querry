export const PLANS = {
  free: {
    name: "Free",
    price: 0,
    monthlyQueries: 100,
    connections: 1,
    features: ["100 AI questions per month", "1 database connection", "Basic usage reports"],
  },
  pro: {
    name: "Pro",
    price: 19,
    monthlyQueries: 2000,
    connections: 5,
    features: ["2,000 AI questions per month", "5 database connections", "Detailed usage reports"],
  },
  business: {
    name: "Business",
    price: 49,
    monthlyQueries: 10000,
    connections: 20,
    features: ["10,000 AI questions per month", "20 database connections", "Priority workspace limits"],
  },
} as const;

export type PlanId = keyof typeof PLANS;
