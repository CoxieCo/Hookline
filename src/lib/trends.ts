// Evergreen short-form video formats the idea generator can build on.
//
// TEMPORARY: hard-coded for now. On Day 4 this becomes a database table so
// formats can be added or retired without a deploy — keep this shape
// (name / description / whyItWorks) in sync with that table when it lands.
//
// These are long-running *formats*, not claims about what is trending today.
// Don't add "currently viral" wording, view counts or dates here.

export type TrendFormat = {
  name: string;
  description: string;
  whyItWorks: string;
};

export const TRENDS = [
  {
    name: "POV",
    description:
      'Shot from the customer\'s point of view, with on-screen text setting up a relatable moment ("POV: you finally found a lead your dog can\'t chew through").',
    whyItWorks: "Viewers picture themselves in the moment, so the product reads as their own solution.",
  },
  {
    name: "Things I wish I knew before buying",
    description:
      "A quick list of honest tips or gotchas about the product category, ending with how this product handles them.",
    whyItWorks: "Insider-style advice earns saves and trust before any selling happens.",
  },
  {
    name: "Problem then solution",
    description: "Open on a specific, frustrating problem the customer has, then show the product solving it.",
    whyItWorks: "A recognisable pain point stops the scroll and the payoff gives a reason to keep watching.",
  },
  {
    name: "Satisfying packing or unboxing",
    description:
      "Close-up, well-lit footage of an order being packed or unboxed, with crisp sounds and tidy, deliberate movements.",
    whyItWorks: "Calm, tactile footage is easy to rewatch and shows the product and packaging in detail.",
  },
  {
    name: "Before and after",
    description: "Show the same thing before and after using the product, with a clear cut or transition between them.",
    whyItWorks: "The contrast makes the benefit visible in seconds without needing to explain it.",
  },
  {
    name: "Stop scrolling if you own a ___",
    description:
      "Call out one specific type of customer in the first second, then give something useful for exactly them.",
    whyItWorks: "Naming the viewer's situation makes the right people stop and filters out everyone else.",
  },
  {
    name: "Day in the life with the product",
    description: "A short run of everyday moments showing where the product naturally fits into the customer's routine.",
    whyItWorks: "Seeing the product in real, ordinary use makes it easy to imagine owning it.",
  },
  {
    name: "Myth-busting",
    description: "State a common belief about the product category, then correct it and show why.",
    whyItWorks: "A surprising correction creates curiosity and positions the brand as the one that knows its stuff.",
  },
  {
    name: "Quick comparison",
    description:
      "Side by side with the 'old way' or a generic alternative, on one or two points the customer actually cares about.",
    whyItWorks: "It answers the question shoppers are already asking themselves.",
  },
  {
    name: "Behind the scenes of a small business",
    description: "Show the people and process behind the store: packing orders, choosing products, testing, mistakes.",
    whyItWorks: "People like buying from people; the human side builds connection and trust.",
  },
] as const satisfies readonly TrendFormat[];

export type TrendName = (typeof TRENDS)[number]["name"];

export const TREND_NAMES = TRENDS.map((t) => t.name) as [TrendName, ...TrendName[]];
