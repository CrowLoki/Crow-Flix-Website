export type OfficialFreeCollectionDraft = {
  title: string;
  url: string;
  category: string;
  audienceCountries?: readonly ("AU" | "US")[];
};

export const OFFICIAL_FREE_COLLECTION_SOURCE =
  "https://github.com/SuperAB123/Free-Official-Youtube-Content";

export const OFFICIAL_FREE_COLLECTION_NAME = "Free Official YouTube Content";

// These entries lead to the original YouTube pages. CrowFlix does not embed,
// download, proxy, or redistribute their videos. The independent source list
// is used as a curation lead; each destination remains the rights-holder's
// own page and keeps YouTube's region and availability controls intact.
export const OFFICIAL_FREE_COLLECTION_DRAFTS: readonly OfficialFreeCollectionDraft[] = [
  { title: "Ani-One Asia", url: "https://www.youtube.com/@AniOneAsia", category: "Official Anime" },
  { title: "GONZO", url: "https://www.youtube.com/@gonzo", category: "Official Anime" },
  { title: "Gundaminfo", url: "https://www.youtube.com/@gundaminfo", category: "Official Anime" },
  { title: "Muse Asia", url: "https://www.youtube.com/@MuseAsia", category: "Official Anime" },
  { title: "Official Yu-Gi-Oh!", url: "https://www.youtube.com/@yugioh", category: "Official Anime" },
  { title: "Pokémon", url: "https://www.youtube.com/@OfficialPoke%CC%81monTV", category: "Official Anime" },
  { title: "TMS ANIME", url: "https://www.youtube.com/@AnimeonTMSOfficialChannel", category: "Official Anime" },
  { title: "Toei Animation", url: "https://www.youtube.com/@ToeiAnimationOfficial", category: "Official Anime" },

  { title: "Angry Birds", url: "https://www.youtube.com/@AngryBirds", category: "Official Cartoons" },
  { title: "Avatar: The Last Airbender", url: "https://www.youtube.com/@avatarthelastairbender", category: "Official Cartoons" },
  { title: "Ben 10", url: "https://www.youtube.com/@Ben10", category: "Official Cartoons" },
  { title: "Code Lyoko English Official", url: "https://www.youtube.com/@CODELYOKOENGLISHOFFICIAL", category: "Official Cartoons" },
  { title: "Disney Channel Animation", url: "https://www.youtube.com/@disneychannelanimation", category: "Official Cartoons" },
  { title: "DreamWorks Madagascar", url: "https://www.youtube.com/@DreamWorksMadagascar", category: "Official Cartoons" },
  { title: "Inspector Gadget", url: "https://www.youtube.com/@InspectorGadget", category: "Official Cartoons" },
  { title: "Johnny Test", url: "https://www.youtube.com/@JohnnyTest", category: "Official Cartoons" },

  { title: "Alphablocks", url: "https://www.youtube.com/@officialalphablocks", category: "Official Kids & Family" },
  { title: "Barbie", url: "https://www.youtube.com/@barbie", category: "Official Kids & Family" },
  { title: "Blippi", url: "https://www.youtube.com/@Blippi", category: "Official Kids & Family" },
  { title: "Bluey", url: "https://www.youtube.com/@BlueyOfficialChannel", category: "Official Kids & Family", audienceCountries: ["AU"] },
  { title: "Curious George", url: "https://www.youtube.com/@CuriousGeorge", category: "Official Kids & Family" },
  { title: "Disney Jr.", url: "https://www.youtube.com/@disneyjr", category: "Official Kids & Family" },
  { title: "Dora Official", url: "https://www.youtube.com/@DoraOfficial", category: "Official Kids & Family" },
  { title: "Horrid Henry", url: "https://www.youtube.com/@HorridHenry", category: "Official Kids & Family" },

  { title: "ABC News In-depth", url: "https://www.youtube.com/@ABCNewsIndepth", category: "Official Documentaries", audienceCountries: ["AU"] },
  { title: "ABC Science", url: "https://www.youtube.com/@abcscience", category: "Official Documentaries", audienceCountries: ["AU"] },
  { title: "American Experience | PBS", url: "https://www.youtube.com/@AmericanExperiencePBS", category: "Official Documentaries", audienceCountries: ["US"] },
  { title: "ARTE.tv Documentary", url: "https://www.youtube.com/@artetvdocumentary", category: "Official Documentaries" },
  { title: "BBC Earth", url: "https://www.youtube.com/@bbcearth", category: "Official Documentaries" },
  { title: "Bloomberg Originals", url: "https://www.youtube.com/bloomberg", category: "Official Documentaries" },
  { title: "Canadian Space Agency", url: "https://www.youtube.com/@canadianspaceagency", category: "Official Documentaries" },
  { title: "National Film Board of Canada", url: "https://www.youtube.com/@nfb", category: "Official Documentaries" },

  { title: "Air Bud TV", url: "https://www.youtube.com/@airbudtv", category: "Official Movies" },
  { title: "Amazon MGM Studios", url: "https://www.youtube.com/@AmazonMGMStudios", category: "Official Movies" },
  { title: "Cult Cinema Classics", url: "https://www.youtube.com/@CultCinemaClassics", category: "Official Movies" },
  { title: "Free Movies by CONtv", url: "https://www.youtube.com/@FreeMoviesByCONtv", category: "Official Movies", audienceCountries: ["US"] },
  { title: "FilmRise", url: "https://www.youtube.com/@FilmRise", category: "Official Movies", audienceCountries: ["US"] },
  { title: "Flix For Free", url: "https://www.youtube.com/@FlixForFree", category: "Official Movies", audienceCountries: ["US"] },
  { title: "Focus Features", url: "https://www.youtube.com/@FocusFeatures", category: "Official Movies", audienceCountries: ["US"] },
  { title: "National Film Board of Canada", url: "https://www.youtube.com/@nfb", category: "Official Movies" },

  { title: "2 Broke Girls", url: "https://www.youtube.com/@2brokegirls", category: "Official TV Shows" },
  { title: "48 Hours", url: "https://www.youtube.com/@48hours", category: "Official TV Shows", audienceCountries: ["US"] },
  { title: "All3Media", url: "https://www.youtube.com/@All3Media", category: "Official TV Shows", audienceCountries: ["US"] },
  { title: "Bar Rescue", url: "https://www.youtube.com/@BarRescue", category: "Official TV Shows", audienceCountries: ["US"] },
  { title: "Baywatch", url: "https://www.youtube.com/@Baywatch", category: "Official TV Shows", audienceCountries: ["US"] },
  { title: "Bondi Rescue", url: "https://www.youtube.com/@BondiRescue", category: "Official TV Shows", audienceCountries: ["AU"] },
  { title: "Border Security", url: "https://www.youtube.com/@bordersecurityofficial", category: "Official TV Shows", audienceCountries: ["AU"] },
  { title: "Brooklyn Nine-Nine", url: "https://www.youtube.com/@NBCBrooklyn99", category: "Official TV Shows", audienceCountries: ["US"] },

  { title: "24 Heures du Mans", url: "https://www.youtube.com/@24heuresdumans", category: "Official Sport" },
  { title: "Australian Open", url: "https://www.youtube.com/@australianopen", category: "Official Sport", audienceCountries: ["AU"] },
  { title: "BWF TV", url: "https://www.youtube.com/@BWF", category: "Official Sport" },
  { title: "Big Bash League", url: "https://www.youtube.com/@BigBash", category: "Official Sport", audienceCountries: ["AU"] },
  { title: "Bundesliga", url: "https://www.youtube.com/@Bundesliga", category: "Official Sport" },
  { title: "FIA", url: "https://www.youtube.com/@FIAOfficialVideo", category: "Official Sport" },
  { title: "Formula 1", url: "https://youtube.com/@formula1", category: "Official Sport" },
  { title: "World Surf League", url: "https://www.youtube.com/@wsl", category: "Official Sport" },

  { title: "ALTER", url: "https://www.youtube.com/@WatchALTER", category: "Official Short Films" },
  { title: "CGMeetup", url: "https://www.youtube.com/@CGMeetup", category: "Official Short Films" },
  { title: "DUST", url: "https://www.youtube.com/@watchdust", category: "Official Short Films" },
  { title: "Film School Shorts", url: "https://www.youtube.com/@filmschoolshorts", category: "Official Short Films" },
  { title: "NOWNESS", url: "https://www.youtube.com/@nowness", category: "Official Short Films" },
  { title: "Omeleto", url: "https://www.youtube.com/@Omeleto", category: "Official Short Films" },
  { title: "Short of the Week", url: "https://www.youtube.com/@shortoftheweek", category: "Official Short Films" },
  { title: "TIFF", url: "https://www.youtube.com/@TIFF", category: "Official Short Films" },
];
