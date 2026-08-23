import { describe, expect, it } from "vitest";
import {
  audiencePreferenceScore,
  isEnglishChannel,
  prioritizeEnglishAustraliaUnitedStates,
} from "./audiencePreferences";

describe("CrowFlix audience preferences", () => {
  it("recognises English language metadata without excluding other languages", () => {
    expect(isEnglishChannel({ country: "AU", languages: ["English"] })).toBe(true);
    expect(isEnglishChannel({ country: "US", languages: ["en"] })).toBe(true);
    expect(isEnglishChannel({ country: "AU", languages: ["French"] })).toBe(false);
  });

  it("puts Australian and American English ahead of the rest while preserving every channel", () => {
    const channels = [
      { name: "French Canada", country: "CA", languages: ["French"] },
      { name: "English United Kingdom", country: "GB", languages: ["English"] },
      { name: "French Australia", country: "AU", languages: ["French"] },
      { name: "English United States", country: "US", languages: ["English"] },
      { name: "English Australia", country: "AU", languages: ["English"] },
    ];

    expect(prioritizeEnglishAustraliaUnitedStates(channels).map((channel) => channel.name)).toEqual([
      "English Australia",
      "English United States",
      "English United Kingdom",
      "French Australia",
      "French Canada",
    ]);
    expect(audiencePreferenceScore(channels[0])).toBe(0);
    expect(prioritizeEnglishAustraliaUnitedStates(channels)).toHaveLength(channels.length);
  });
});
