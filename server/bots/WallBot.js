import crypto from 'node:crypto';
import {
  getSettings, getWallState, upsertWallState, incWallCheck, incRaidCheck,
  topWallCheckers, allWallCheckers,
  listWallPlayers, getWallPlayer, upsertWallPlayer, setDisplayName, missingDisplayNames, lastWallChecker, lastRaidChecker, linkPlayerUuid,
  setTaxStatus, resetTaxStatuses, saveTax, setTaxReminderAt, clearTax, setPostedBans, DEFAULT_USER_ID,
  CHECK_DEFAULT, DISCORD_REMINDER_DEFAULT, DISCORD_RAID_DEFAULT,
  RAID_OUTPOST_REMINDER_DEFAULT, DISCORD_RAID_OUTPOST_DEFAULT,
} from '../db/db.js';
import { issueReportToken, reportUrl } from '../report.js';

// Discord embed accent colours, as the integers the webhook API expects.
const COLOR_ALERT = 0xED4245; // red — reminders and raids
const COLOR_OK = 0x57F287;    // green — a check landed
const COLOR_MUTED = 0x99AAB5; // grey — an all-clear
const COLOR_LOG = 0x22D3EE;   // cyan — the check log (walls)
const COLOR_RAID_LOG = 0x9B59B6; // purple — the check log (Raid Outpost)
const COLOR_BOARD = 0xF1C40F; // gold — the factions leaderboard
const COLOR_MATCH = 0xFF5FA2; // pink — a "find me" match card
const COLOR_TAX = 0x2ECC71;   // money green — tax announcements

// Player head for the log embed's author line. Discord fetches this itself, so the player's name
// reaches a third-party skin service rather than us calling out. Blank the constant to drop it.
const HEAD_URL = (player) => `https://mc-heads.net/avatar/${encodeURIComponent(player)}/64`;

// MHF_TNT is one of Mojang's stock heads, so the same skin service renders a TNT block —
// no second image host to depend on.
const TNT_ICON = HEAD_URL('MHF_TNT');
const RAID_TITLE = 'WE ARE GETTING RAIDED!';

const TICK_MS = 30 * 1000;             // how often the reminder loop wakes up
const CHECK_COOLDOWN_MS = 60 * 1000;   // per-player cooldown between counted checks
const SEND_GAP_MS = 1500;              // minimum spacing between outbound chat messages
const HOUR_MS = 60 * 60 * 1000;
const VERIFY_MAX_PER_HOUR = 5;         // wrong password/code guesses allowed per player, per hour
const CODE_TTL_MS = 15 * 60 * 1000;    // how long an issued verification code stays usable
const REPORT_MAX_PER_HOUR = 3;         // report links one player can request per hour
const MATCH_MAX_PER_HOUR = 5;          // "find me" cards one player can request per hour
const NOTICE_COOLDOWN_MS = 60 * 1000;  // how often one player can be told to verify
const RECENT_SENT_MAX = 20;            // echo-suppression ring size
const TAX_REMINDER_MS = 12 * HOUR_MS;  // how often a running tax re-pings whoever hasn't paid
const TAX_MIN_MS = 60 * 1000;
const TAX_MAX_MS = 30 * 24 * HOUR_MS;

const UUID_CACHE_MS = 24 * 60 * 60 * 1000; // how long a name -> UUID answer from Mojang is trusted
const UUID_LOOKUP_TIMEOUT_MS = 3000;

const RAID_OUTPOST_CHECK_DEFAULT = 'Raid Outpost checked by {player} [{checks}]';

// Raid Outpost server broadcasts, matched against color-stripped lines. Unanchored, so a server
// prefix in front of the "(!)" doesn't break them.
export const RAID_OUTPOST_CLAIMED_RE = /\(!\)\s+([A-Za-z0-9_]+)\s+have claimed the Raid Outpost!/i;
export const RAID_OUTPOST_COOLDOWN_RE = /The raid outpost is now unavailable for 1 HOUR!/i;
export const RAID_OUTPOST_STARTED_RE = /A RAID OUTPOST HAS STARTED!/i;
// Ban feed: Shiva's (the anticheat) ban broadcast makes us read the public bans page and post bans
// we haven't posted yet. Unanchored, like the outpost regexes, so a server prefix doesn't break it.
export const SHIVA_RE = /\[SHIVA\]\s*A player was banned/i;
export const BANS_URL = 'https://cosmicreborn.com/punishments/bans';
const BAN_FETCH_DELAYS_MS = [15 * 1000, 60 * 1000, 180 * 1000]; // the site can lag the chat line
const BAN_POLL_MS = 10 * 60 * 1000; // also re-read the page this often, so unbans show without a new ban
const BAN_LOOKUP_URL = (player) => `https://cosmicreborn.com/punishments/lookup?search=${encodeURIComponent(player)}`;
const BAN_LOOKUPS_PER_SYNC = 10; // ledger bans re-checked on their lookup page per sync, longest-unchecked first
// ponytail: ledger keeps every active ban 90 days, then forgets it; raise if old permanents' unbans matter.
const BAN_TRACK_MS = 90 * 24 * 3600e3;
const BAN_LOOKBACK_MS = 10 * 60 * 1000; // only bans this close to the Shiva line count as new
// "find me a goth mommy" -> a fictional profile card in Discord. Never a real person: the name and
// age are made up here, and the only picture is the requester's own Minecraft head.
export const MATCH_RE = /^\s*find\s+me\s+(?:an?\s+|some\s+)?(.{1,60}?)[\s.!?]*$/i;
// Anything that reads as asking for a minor is dropped silently. Bare numbers under 18 count too.
/** The cleaned-up ask from a "find me ..." message, or '' when the message isn't one. */
export function parseMatchQuery(message) {
  const m = MATCH_RE.exec(message);
  return m ? m[1].replace(/[`*_~|<>@#]/g, '').trim() : '';
}
export const MINOR_RE = /\b(?:teens?|teenage(?:r|rs)?|young(?:er)?|kids?|child(?:ren)?|minors?|underage|jailbait|loli(?:ta)?|shota|school\s*(?:girl|boy)s?|(?:high|middle)\s*school(?:er)?|pre-?teens?|bab(?:y|ies)|little|petite|tiny|[0-9]|1[0-7])\b/i;
// One entry per vibe: the stereotypical common names for it (f = women, m = men) and Hinge-style
// prompt answers in its voice, on the prompts Hinge reports as most successful. First regex hit
// wins; the last entry is the catch-all. `spicy` answers join the pool only when match_nsfw is on.
const MATCH_TYPES = [
  {
    re: /goth|emo|alt\b|punk|metal|vamp|witch|grunge/i,
    f: ["Raven", "Luna", "Lilith", "Morgan", "Nyx", "Ivy", "Willow", "Scarlett", "Violet", "Jade", "Elvira", "Morticia", "Ophelia", "Sable", "Onyx"],
    m: ["Damien", "Ash", "Dante", "Vincent", "Silas", "Jett", "Corbin", "Rowan", "Sebastian", "Kai", "Lucian", "Damon", "Draven", "Alaric", "Ezra"],
    prompts: [
      ["My simple pleasures", "Thunderstorms, black coffee and a horror movie I've already seen"],
      ["Typical Sunday", "Thrifting, then a cemetery walk, then takeout in bed"],
      ["I go crazy for", "Anyone who can name more than one Type O Negative song"],
      ["Together, we could", "Get matching tattoos and regret nothing"],
      ["The way to win me over is", "Bite me. Literally, I'm into that"],
      ["Dating me is like", "A Tim Burton movie. Weird, a little dark, worth it"],
      ["My most irrational fear", "Tan lines"],
      ["I'm looking for", "Someone who thinks Halloween is a lifestyle"],
      ["We'll get along if", "You don't mind black on everything I own"],
      ["Green flags I look for", "You cry at the end of Corpse Bride too"],
      ["Typical Sunday", "Vintage shop, coffee black as my soul, then a seance"],
      ["I go crazy for", "Dark lipstick and someone who reads poetry"],
      ["Dating me is like", "A haunted house. Spooky at first, then you never want to leave"],
    ],
    spicy: [
      ["The way to win me over is", "Pin me down and tell me I'm your favorite nightmare"],
      ["I go crazy for", "Collars, candlelight and getting bitten in the right places"],
      ["Together, we could", "Skip the movie and get a noise complaint from the neighbors"],
      ["I'm looking for", "A pet who knows to call me Mommy and mean it"],
      ["The way to win me over is", "Getting on your knees and asking nicely"],
      ["I go crazy for", "Leather, restraints and leaving marks you'll have to explain at work"],
      ["Together, we could", "Find out how long you last before you beg"],
      ["Dating me is like", "Being owned. Leash optional, obedience not"],
      ["My simple pleasures", "Red wine, candle wax and you tied to my bedpost"],
      ["Green flags I look for", "You have a safeword and you know when not to use it"],
      ["I go crazy for", "Collars with your name tag on my nightstand"],
      ["The way to win me over is", "Kneeling before I tell you to"],
      ["Typical Sunday", "Brunch, then a trip to the toy store, then you don't leave the bed"],
      ["We'll get along if", "You like being told no. And then yes"],
      ["I'm looking for", "Someone to tie up with my good fishnets"],
      ["Together, we could", "Find out what happens when the candles burn down"],
      ["Dating me is like", "A cage. You'll ask to be let in"],
      ["My simple pleasures", "Blindfolds, a riding crop and a long night"],
      ["My most irrational fear", "A sub who can't follow instructions"],
      ["I'm looking for", "A good boy or girl who earns their treats"],
      ["The way to win me over is", "Saying 'yes, Mommy' without being asked twice"],
      ["I go crazy for", "Spiked collars, silk rope and the sound of you begging"],
      ["Together, we could", "Test how many rules you can follow in one night"],
      ["Dating me is like", "Signing a contract. Read the fine print, it's all kinks"],
      ["My simple pleasures", "Painting my nails black while you wait on the floor"],
      ["Typical Sunday", "Morning coffee served on your knees"],
      ["We'll get along if", "You like being praised and punished in the same breath"],
      ["Green flags I look for", "You check in, then you do exactly as you're told"],
      ["My most irrational fear", "Running out of rope halfway through"],
      ["I go crazy for", "Leaving lipstick marks everywhere my collar doesn't cover"],
      ["The way to win me over is", "Letting me pick your outfit. And when you take it off"],
    ],
  },
  {
    re: /\babg\b|\babb\b|asian/i,
    f: ["Vivian", "Michelle", "Jessica", "Christine", "Tiffany", "Jennifer", "Kimberly", "Emily", "Angela", "Amy", "Cindy", "Stephanie", "Kelly", "Vanessa", "Annie"],
    m: ["Kevin", "Brian", "Andrew", "Jason", "Eric", "Justin", "Daniel", "Ryan", "Michael", "Brandon", "Jonathan", "Kenny", "Vincent", "Alex", "Tony"],
    prompts: [
      ["The way to win me over is", "A boba run where you already know my order"],
      ["Typical Sunday", "Dim sum hangover cure, then a nap until the rave"],
      ["I go crazy for", "Hot pot at 2am and anyone who'll go with me"],
      ["Together, we could", "Hit every EDM festival this summer"],
      ["I'm looking for", "Someone my mom will feed seconds to"],
      ["Dating me is like", "A night market. Loud, a little chaotic, you'll want more"],
      ["My most irrational fear", "Running out of lash glue before a night out"],
      ["My simple pleasures", "Fresh lashes, a matcha latte and a full camera roll"],
      ["Green flags I look for", "You know how to get us a table"],
      ["We'll get along if", "You can hang with my group chat of nine"],
      ["The way to win me over is", "Matching my energy at the afterparty"],
      ["Typical Sunday", "Brunch at noon, nails at two, club by eleven"],
      ["My most irrational fear", "My car getting towed outside the club"],
      ["My simple pleasures", "Late night pho and a long car ride"],
      ["I'm looking for", "Someone who can parallel park my Civic"],
      ["Green flags I look for", "You know boba from milk tea"],
      ["Together, we could", "Hit every K-BBQ spot in the city"],
      ["We'll get along if", "You survive my 40-minute skincare routine"],
    ],
    spicy: [
      ["The way to win me over is", "Buy me dinner, then don't let me make it to the rave"],
      ["I'm looking for", "Someone who can keep up after the afterparty"],
      ["Dating me is like", "Ordering extra spicy. You'll be sweating by the end"],
      ["I go crazy for", "Getting wild after two drinks and pretending it was one"],
      ["The way to win me over is", "Kissing me in the Uber on the way home"],
      ["My most irrational fear", "Waking up and you're already gone"],
      ["I'm looking for", "Someone who lasts longer than the afterparty"],
      ["My simple pleasures", "Waking up in your hoodie and nothing else"],
      ["Together, we could", "Skip the club and keep the lights low at my place"],
      ["We'll get along if", "You like it when I take charge after a few drinks"],
      ["Green flags I look for", "You don't flinch when I say I'm not tired yet"],
      ["Typical Sunday", "Breakfast in bed, then back to bed"],
    ],
  },
  {
    re: /e-?girl|e-?boy|discord kitten|kitten/i,
    f: ["Kenzie", "Ari", "Mika", "Lexi", "Bella", "Sky", "Ruby", "Cleo", "Hailey", "Kira", "Rae", "Kat", "Nyla", "Mimi", "Juno"],
    m: ["Ezra", "Jace", "Kai", "Milo", "Zane", "River", "Eli", "Finn", "Jett", "Nico", "Theo", "Rory", "Sasha", "Ren", "Asher"],
    prompts: [
      ["My simple pleasures", "Cat ear headphones, a fresh eyeliner wing and a Monster"],
      ["Typical Sunday", "TikTok until noon, Discord call until 3am"],
      ["I go crazy for", "Chains, platform boots and anyone who matches my fit"],
      ["I'm looking for", "Someone to be cringe with in public"],
      ["Dating me is like", "A Pinterest board. Aesthetic, a little chaotic"],
      ["Together, we could", "Make a TikTok that gets 2 views and love it anyway"],
      ["My most irrational fear", "My lashes coming off on stream"],
      ["Green flags I look for", "You let me do your eyeliner"],
      ["We'll get along if", "You send me memes at 4am"],
      ["The way to win me over is", "Gifting me Discord Nitro"],
      ["My simple pleasures", "Ring light, lip gloss and a voice channel full of friends"],
      ["Dating me is like", "A Twitch stream. Lots of chat, occasional chaos"],
      ["Typical Sunday", "Sleep till 2, thrift haul, Discord movie night"],
      ["I go crazy for", "Hello Kitty, chains and painted nails"],
      ["The way to win me over is", "Remembering my favorite emote"],
      ["Green flags I look for", "You don't make fun of my Pinterest boards"],
      ["My most irrational fear", "Losing my Duolingo streak"],
    ],
    spicy: [
      ["The way to win me over is", "Call me a good girl and see what happens"],
      ["I'm looking for", "Someone who knows what the choker is for"],
      ["Together, we could", "Turn the camera off and find out what I'm like offline"],
      ["I go crazy for", "Being told what to do. Nicely"],
      ["We'll get along if", "You don't mind getting bossed around a little"],
      ["My simple pleasures", "Thigh highs and someone to appreciate them"],
      ["Dating me is like", "A private stream. Invite only"],
      ["The way to win me over is", "Calling me your kitten and meaning it"],
      ["I go crazy for", "A collar with a bell and you holding the leash"],
      ["I'm looking for", "Someone who gives orders in VC"],
      ["Together, we could", "Find out what every setting on the toy app does"],
      ["Typical Sunday", "Cosplay photoshoot, then the outfit comes off"],
      ["My most irrational fear", "Leaving my camera on by accident. Or on purpose"],
    ],
  },
  {
    re: /gamer|streamer|discord|valorant|fortnite/i,
    f: ["Hailey", "Madison", "Kayla", "Chloe", "Ashley", "Zoe", "Bella", "Lexi", "Maya", "Nova", "Riley", "Ava", "Sophie", "Emma", "Paige"],
    m: ["Tyler", "Jake", "Logan", "Ethan", "Mason", "Noah", "Caleb", "Liam", "Aiden", "Dylan", "Jacob", "Austin", "Connor", "Brandon", "Cole"],
    prompts: [
      ["I'm looking for", "Player two. Must main support"],
      ["My simple pleasures", "Energy drinks and a 4am lobby that finally wins"],
      ["The way to win me over is", "Carrying me in ranked without saying a word about it"],
      ["Together, we could", "Stay up all night and blame the queue times"],
      ["We'll get along if", "You don't rage quit"],
      ["Dating me is like", "A loot box. Could be legendary, could be chaos"],
      ["My most irrational fear", "My mic being on when I thought it was muted"],
      ["Typical Sunday", "Patch notes and breakfast at 3pm"],
      ["I go crazy for", "A setup with more RGB than sense"],
      ["Green flags I look for", "You don't mind me finishing one last match"],
      ["I'm looking for", "A duo partner who doesn't throw"],
      ["Dating me is like", "Respawning. I always come back"],
      ["Together, we could", "Build a Minecraft base and argue about the roof"],
      ["My simple pleasures", "A clutch 1v3 and a cold Mountain Dew"],
      ["Typical Sunday", "Speedrun attempts and pizza rolls"],
      ["Green flags I look for", "You don't unplug my PC to vacuum"],
      ["The way to win me over is", "Knowing my K/D without asking"],
      ["We'll get along if", "You pretend my aim is good"],
    ],
    spicy: [
      ["I go crazy for", "Someone who makes me forget I'm in queue"],
      ["Together, we could", "End the stream and find out how long I last"],
      ["I'm looking for", "A player two who likes to take control"],
      ["The way to win me over is", "Showing me what those fast hands can do"],
      ["My simple pleasures", "Losing on purpose so you'll punish me"],
      ["Dating me is like", "A long session with no pauses"],
      ["I'm looking for", "Someone to go hardcore mode with"],
      ["Together, we could", "Play strip Mario Kart. Blue shells cost clothes"],
      ["I go crazy for", "Being called a good player two"],
      ["We'll get along if", "You don't mind me being loud"],
      ["Green flags I look for", "You're good with a controller and better with your hands"],
      ["Typical Sunday", "Lose every match and make it up to you in bed"],
    ],
  },
  {
    re: /latin|spanish|mexican|puerto|colombian|cuban/i,
    f: ["Sofia", "Isabella", "Valentina", "Camila", "Gabriela", "Daniela", "Mariana", "Lucia", "Ximena", "Andrea", "Alejandra", "Paola", "Natalia", "Fernanda", "Jimena"],
    m: ["Mateo", "Santiago", "Diego", "Alejandro", "Carlos", "Luis", "Javier", "Adrian", "Miguel", "Angel", "Jose", "Juan", "Gabriel", "Emilio", "Rafael"],
    prompts: [
      ["The way to win me over is", "Keeping up with me on the dance floor"],
      ["Typical Sunday", "Family lunch that somehow lasts until dinner"],
      ["I go crazy for", "Street tacos and anyone who can handle spice"],
      ["Green flags I look for", "You actually eat when my abuela offers"],
      ["Together, we could", "Salsa class, then see who leads"],
      ["Dating me is like", "Hot sauce. A lot at first, then you're addicted"],
      ["My most irrational fear", "The chancla"],
      ["My simple pleasures", "Bad Bunny at full volume and a cafecito"],
      ["I'm looking for", "Someone who dances at the carne asada"],
      ["We'll get along if", "You survive my family group chat"],
      ["Typical Sunday", "Misa, menudo, then futbol on the TV"],
      ["The way to win me over is", "Learning my mom's name before mine"],
      ["Green flags I look for", "You can handle hot Cheetos with lime"],
      ["I'm looking for", "Someone who knows a good pupusa spot"],
      ["Together, we could", "Cook arroz con pollo and burn it together"],
      ["I go crazy for", "Selena on vinyl and a cold Jarritos"],
      ["Dating me is like", "A quinceanera. Big, loud and everybody's dancing"],
      ["My most irrational fear", "Telling my mom we broke up"],
    ],
    spicy: [
      ["The way to win me over is", "Dancing close enough to feel it"],
      ["Dating me is like", "Extra hot. You were warned"],
      ["Together, we could", "Skip salsa class and practice somewhere private"],
      ["I go crazy for", "Being whispered to in Spanish, slowly"],
      ["I'm looking for", "Someone who knows how to move their hips"],
      ["The way to win me over is", "Making me late for Sunday dinner"],
      ["My simple pleasures", "Bachata in the kitchen that ends on the counter"],
      ["Together, we could", "Make the neighbors learn my name"],
      ["We'll get along if", "You can handle me being loud"],
      ["Typical Sunday", "Sleeping in after a very long night"],
      ["Green flags I look for", "You take your time. All night"],
      ["Dating me is like", "Tequila. Burns going down, can't stop after"],
    ],
  },
  {
    re: /country|cowgirl|cowboy|southern|farm|rodeo|redneck/i,
    f: ["Kaylee", "Savannah", "Brooke", "Lainey", "Hannah", "Taylor", "Emma", "Ella", "Reese", "Dixie", "Addison", "Josie", "Callie", "Maddie", "Kenzie"],
    m: ["Wyatt", "Colton", "Cody", "Luke", "Hunter", "Tucker", "Garrett", "Hank", "Beau", "Waylon", "Bryce", "Dalton", "Ty", "Jesse", "Clay"],
    prompts: [
      ["The way to win me over is", "Taking me two-steppin'"],
      ["My simple pleasures", "Bonfires, back roads and sweet tea"],
      ["Typical Sunday", "Church, then the lake, then the bar"],
      ["Together, we could", "Ride off into the sunset. I'll drive the truck"],
      ["I'm looking for", "Someone who can save a horse"],
      ["Dating me is like", "A country song. Starts sweet, ends with a truck"],
      ["My most irrational fear", "City parking"],
      ["I go crazy for", "Anyone in Wranglers"],
      ["Green flags I look for", "You say ma'am and mean it"],
      ["We'll get along if", "You can sit through a whole Luke Combs set"],
      ["My simple pleasures", "A cold beer on a tailgate at sunset"],
      ["I'm looking for", "Someone to share my porch swing with"],
      ["Dating me is like", "A dirt road. Bumpy, but it gets you somewhere good"],
      ["Typical Sunday", "Fishing pole in one hand, Busch Light in the other"],
      ["The way to win me over is", "Fixing my fence without being asked"],
      ["Together, we could", "Build a bonfire you can see from the highway"],
      ["Green flags I look for", "You wave at every truck that passes"],
      ["My most irrational fear", "Running out of gas on a back road"],
    ],
    spicy: [
      ["I'm looking for", "A cowboy who knows how to ride"],
      ["The way to win me over is", "Taking the long way home and parking somewhere quiet"],
      ["I go crazy for", "Tight jeans, a truck bed and no tan lines"],
      ["My simple pleasures", "Getting tangled up in the truck bed under the stars"],
      ["I go crazy for", "Someone who knows what to do with a rope"],
      ["Dating me is like", "Eight seconds is the minimum"],
      ["I'm looking for", "A cowboy who can ride all night"],
      ["Together, we could", "Fog up the truck windows at the drive-in"],
      ["The way to win me over is", "Strong hands and a belt buckle I can undo"],
      ["We'll get along if", "You like it a little rough"],
      ["Typical Sunday", "The hayloft, then a long nap"],
      ["Green flags I look for", "You tip your hat before you take it off"],
    ],
  },
  {
    re: /gym|fit|lift|athlet|swole|muscle|crossfit/i,
    f: ["Ashley", "Brittany", "Taylor", "Alexis", "Jordan", "Megan", "Sierra", "Kendall", "Morgan", "Paige", "Kaitlyn", "Haley", "Lindsey", "Courtney", "Tori"],
    m: ["Chad", "Tyler", "Brett", "Derek", "Trevor", "Kyle", "Blake", "Cole", "Zach", "Austin", "Brock", "Chase", "Lance", "Ryder", "Jake"],
    prompts: [
      ["My simple pleasures", "A new PR and a protein shake after"],
      ["Typical Sunday", "Meal prep, leg day, sauna"],
      ["Green flags I look for", "You don't skip cardio"],
      ["The way to win me over is", "Spotting me without staring. Or staring, a little"],
      ["Together, we could", "Hit a new PR and celebrate with something I'd never post"],
      ["Dating me is like", "A pre-workout. Intense, then you crash happy"],
      ["My most irrational fear", "The gym being closed on a holiday"],
      ["I'm looking for", "A lifting partner who doesn't ghost after week two"],
      ["I go crazy for", "Chicken, rice and clean reps"],
      ["We'll get along if", "You don't judge my pre-workout dosage"],
      ["Green flags I look for", "You rerack your weights"],
      ["Dating me is like", "A drop set. Keeps going after you think it's over"],
      ["My most irrational fear", "Skipping leg day by accident"],
      ["Typical Sunday", "Rest day. Kidding, it's chest day"],
      ["The way to win me over is", "Bringing me a protein bar after my set"],
      ["Together, we could", "Train for a half marathon and never sign up"],
      ["My simple pleasures", "Ice baths and an early night"],
      ["Green flags I look for", "You track macros without making it your personality"],
    ],
    spicy: [
      ["My simple pleasures", "Getting sweaty with someone, gym optional"],
      ["The way to win me over is", "Picking me up like a PR"],
      ["Together, we could", "Find out if my stamina is just for cardio"],
      ["The way to win me over is", "Showing me that grip strength"],
      ["I go crazy for", "Post-workout everything"],
      ["I'm looking for", "Someone who can go more than one round"],
      ["Together, we could", "Burn more calories in bed than on the treadmill"],
      ["My simple pleasures", "Getting pinned after a heavy set"],
      ["We'll get along if", "You like being thrown around a little"],
      ["Typical Sunday", "Leg day, then making mine shake for a different reason"],
      ["Green flags I look for", "You have the stamina to back it up"],
      ["Dating me is like", "HIIT. Lots of reps, no rest"],
    ],
  },
  {
    re: /nerd|geek|anime|weeb|book|cosplay|dnd|d&d/i,
    f: ["Emily", "Hannah", "Abigail", "Olivia", "Grace", "Claire", "Natalie", "Rachel", "Audrey", "Lily", "Ruth", "Iris", "Eleanor", "Penny", "Evelyn"],
    m: ["Ethan", "Nathan", "Owen", "Elliot", "Simon", "Henry", "Max", "Isaac", "Oliver", "Calvin", "Arthur", "Wesley", "Milo", "Leon", "Felix"],
    prompts: [
      ["I go crazy for", "A bookstore with a cafe in it"],
      ["I'm looking for", "A bard for my campaign. And my heart"],
      ["Typical Sunday", "Rewatching an anime I've seen four times"],
      ["Together, we could", "Cosplay as a duo at the next con"],
      ["We'll get along if", "You have opinions about the Fellowship"],
      ["Dating me is like", "A side quest. Optional, but the best part"],
      ["My most irrational fear", "Someone spoiling the finale"],
      ["My simple pleasures", "New book smell and a rainy day off"],
      ["Green flags I look for", "You have a favorite Pokemon and a reason why"],
      ["The way to win me over is", "A handwritten note. Bonus points in Elvish"],
      ["I'm looking for", "Someone to go to midnight premieres with"],
      ["Together, we could", "Finish a 1000-piece puzzle and frame it"],
      ["We'll get along if", "You don't mind long lore explanations"],
      ["Typical Sunday", "Library, board game cafe, bed by ten"],
      ["I go crazy for", "Star Wars trivia and fancy notebooks"],
      ["Dating me is like", "An open world game. So much to discover"],
      ["My most irrational fear", "Losing my save file"],
      ["Green flags I look for", "You remember my D&D party's names"],
    ],
    spicy: [
      ["I go crazy for", "Roleplay. Not just the D&D kind"],
      ["I'm looking for", "Someone to roll for initiative with in bed"],
      ["Dating me is like", "A spicy fanfic. Slow burn, then chapter 12"],
      ["Dating me is like", "A dungeon crawl. You'll explore every corner"],
      ["My simple pleasures", "Glasses on, nothing else"],
      ["The way to win me over is", "Whispering the lore in my ear"],
      ["I'm looking for", "A dungeon master who means it literally"],
      ["Together, we could", "Act out every spicy fanfic I've bookmarked"],
      ["I go crazy for", "Being called a good little nerd"],
      ["We'll get along if", "You like it when I read you the smut parts out loud"],
      ["Typical Sunday", "Cosplay in the morning, out of costume by noon"],
      ["Green flags I look for", "You're patient. Slow burn is a lifestyle"],
    ],
  },
  {
    re: /baddie|bad b|rich|model|influencer|bougie/i,
    f: ["Destiny", "Jasmine", "Aaliyah", "Brianna", "Mia", "Kylie", "Nia", "Amber", "Jada", "Diamond", "Ciara", "Kiana", "Tatiana", "Essence", "Mariah"],
    m: ["Marcus", "Jordan", "Andre", "Xavier", "Isaiah", "Malik", "Dominic", "Cameron", "Jalen", "Zion", "Tre", "Jaden", "Kendrick", "Devin", "Elijah"],
    prompts: [
      ["The way to win me over is", "A dinner reservation I didn't have to make"],
      ["My simple pleasures", "Fresh nails and a good angle"],
      ["I'm looking for", "Someone who can keep up with my standards"],
      ["Together, we could", "Take a trip that ruins everyone's feed"],
      ["Green flags I look for", "You open doors and Venmo back fast"],
      ["Dating me is like", "Designer. Expensive, worth it"],
      ["My most irrational fear", "Bad lighting"],
      ["Typical Sunday", "Bottomless mimosas and a nap I deserve"],
      ["I go crazy for", "Someone who plans the whole date"],
      ["We'll get along if", "You take good pictures of me"],
      ["My most irrational fear", "A guy who says 'I'm not really a texter'"],
      ["The way to win me over is", "Showing up on time with flowers"],
      ["My simple pleasures", "A sunset dinner on a rooftop"],
      ["I'm looking for", "Someone with a passport and a plan"],
      ["Together, we could", "Get matching Cartier bracelets"],
      ["Green flags I look for", "You hype me up in the comments"],
      ["Typical Sunday", "Face mask, self care and ignoring everyone"],
      ["Dating me is like", "A first class upgrade. No going back"],
    ],
    spicy: [
      ["The way to win me over is", "Spoiling me. I'll make it worth your while"],
      ["I'm looking for", "Someone who knows exactly what to do with me"],
      ["Together, we could", "Make room service blush"],
      ["I go crazy for", "Being spoiled in every way you can imagine"],
      ["Dating me is like", "A luxury suite. Worth the price, open all night"],
      ["We'll get along if", "You don't need to be told twice"],
      ["I'm looking for", "Someone who can keep up all night"],
      ["Together, we could", "Make room service knock twice"],
      ["The way to win me over is", "Hands on my waist and knowing exactly where to go next"],
      ["We'll get along if", "You beg pretty"],
      ["Typical Sunday", "Lingerie haul, then a private fashion show"],
      ["Green flags I look for", "You like being told exactly what I want"],
    ],
  },
  {
    re: /tom\s*boy|skater|sporty/i,
    f: ["Sam", "Alex", "Charlie", "Jordan", "Riley", "Frankie", "Max", "Billie", "Jo", "Casey", "Mel", "Toni", "Drew", "Bobbie", "Remi"],
    m: ["Jake", "Ryan", "Tyler", "Cody", "Matt", "Nick", "Josh", "Kyle", "Sean", "Brandon", "Chris", "Danny", "Mike", "Ben", "Jamie"],
    prompts: [
      ["My simple pleasures", "Basketball shorts, a backwards cap and a gas station hot dog"],
      ["The way to win me over is", "Beating me at Smash. Nobody has"],
      ["Typical Sunday", "Pickup game, then wings, then a nap"],
      ["I go crazy for", "Skate parks, sneaker drops and cheap pizza"],
      ["I'm looking for", "Someone who can keep up on a hike"],
      ["Dating me is like", "Hanging out with your best friend who happens to be cute"],
      ["Together, we could", "Build a half pipe in the backyard"],
      ["Green flags I look for", "You don't care that I wear your hoodies better"],
      ["My most irrational fear", "Wearing a dress to a wedding"],
      ["We'll get along if", "You can take a little trash talk"],
      ["Typical Sunday", "Fishing at 6am, then breakfast burritos"],
      ["I'm looking for", "A teammate in life and in pickup basketball"],
      ["I go crazy for", "Fishing trips and beat-up Vans"],
      ["Together, we could", "Go to a hockey game and yell the whole time"],
      ["My simple pleasures", "Cold pizza for breakfast"],
      ["My most irrational fear", "Losing to my little brother at 2K"],
      ["The way to win me over is", "Teaching me a kickflip without laughing"],
    ],
    spicy: [
      ["The way to win me over is", "Wrestling me. Loser picks the next round"],
      ["I go crazy for", "Getting pinned in a fair fight"],
      ["Together, we could", "Find out I'm not so tough after all"],
      ["I'm looking for", "Someone who can match me in the gym and after it"],
      ["My simple pleasures", "Your hoodie and nothing underneath"],
      ["The way to win me over is", "Making me forget I'm the tough one"],
      ["Dating me is like", "Roughhousing that goes somewhere"],
      ["I go crazy for", "Getting pinned and losing on purpose"],
      ["Together, we could", "Play one-on-one, winner picks the position"],
      ["We'll get along if", "You like it when I take control"],
      ["Typical Sunday", "Gym, shower together, back to bed"],
      ["I'm looking for", "Someone who can make me blush. Good luck"],
      ["The way to win me over is", "Pulling me in by the hoodie strings"],
    ],
  },
  {
    re: /hood|ghetto|ratchet|thug|street|\btrap\b/i,
    f: ["Aaliyah", "Imani", "Kiara", "Nia", "Tiana", "Keisha", "Monique", "Jada", "Brianna", "Shanice", "Tasha", "Ebony", "Dominique", "Jazmine", "Kayla"],
    m: ["Marcus", "Darius", "Malik", "Jaylen", "Terrell", "Andre", "DeShawn", "Isaiah", "Jamal", "Dominic", "Tyrell", "Jerome", "Rashad", "Cedric", "Quinton"],
    prompts: [
      ["My simple pleasures", "Hennessy, hot wings and a good playlist"],
      ["The way to win me over is", "Loyalty. That's the whole list"],
      ["Typical Sunday", "Pull up to the cookout and stay till the streetlights come on"],
      ["I go crazy for", "Fresh Jordans and a fresh cut"],
      ["I'm looking for", "Someone who rides for me, no questions"],
      ["Dating me is like", "Riding shotgun with the bass up"],
      ["Together, we could", "Go to the strip club for the wings. Just the wings"],
      ["Green flags I look for", "You know every word to old Lil Wayne"],
      ["We'll get along if", "You don't mind my cousins pulling up unannounced"],
      ["My most irrational fear", "Somebody eating the last wing"],
      ["My simple pleasures", "Sunday dinner at grandma's"],
      ["Dating me is like", "A summer block party. Loud, fun, everybody's invited"],
      ["The way to win me over is", "Bringing me a plate from the function"],
      ["I go crazy for", "Spades nights where somebody's always cheating"],
      ["Together, we could", "Hit the car wash and ride with the windows down"],
      ["I'm looking for", "Someone real. No fake love"],
      ["My most irrational fear", "Somebody stepping on my fresh sneakers"],
    ],
    spicy: [
      ["The way to win me over is", "Treat me right and I'll treat you better"],
      ["I go crazy for", "Late night pull ups, no questions asked"],
      ["I'm looking for", "Someone who can handle all this"],
      ["Together, we could", "Fog up the Charger windows"],
      ["The way to win me over is", "Pulling up at 2am and not making me wait"],
      ["Dating me is like", "Hennessy. Smooth, then it hits you"],
      ["My simple pleasures", "Slow jams with the lights off"],
      ["I'm looking for", "Somebody who knows how to put it down"],
      ["Together, we could", "Make the bed louder than the speakers"],
      ["I go crazy for", "Late night calls that end with you at my door"],
      ["We'll get along if", "You don't leave before breakfast"],
      ["Typical Sunday", "Laying up all day, phones off"],
      ["Green flags I look for", "You whisper what you're gonna do, then you do it"],
    ],
  },
  {
    re: /./,
    f: ["Emma", "Olivia", "Ava", "Sophia", "Mia", "Isabella", "Charlotte", "Amelia", "Harper", "Ella", "Abigail", "Emily", "Grace", "Chloe", "Madison"],
    m: ["Liam", "Noah", "Oliver", "James", "Elijah", "William", "Henry", "Lucas", "Benjamin", "Jack", "Mason", "Logan", "Ethan", "Daniel", "Michael"],
    prompts: [
      ["My simple pleasures", "Iced coffee and a parking spot right out front"],
      ["Typical Sunday", "Farmers market, then a nap"],
      ["The way to win me over is", "Making me laugh at something I shouldn't"],
      ["I'm looking for", "Someone to share fries with"],
      ["Together, we could", "Take a spontaneous road trip with no plan"],
      ["Dating me is like", "A playlist on shuffle. Something good every time"],
      ["My most irrational fear", "Birds. They know something"],
      ["Green flags I look for", "You're nice to waiters"],
      ["We'll get along if", "You laugh at your own jokes"],
      ["I go crazy for", "A good taco and a better playlist"],
      ["Typical Sunday", "Sleeping in, then pancakes"],
      ["My most irrational fear", "Accidentally liking an old photo"],
      ["Dating me is like", "Your favorite sweater. Comfy and always there"],
      ["I'm looking for", "Someone to try every brunch spot with"],
      ["The way to win me over is", "Remembering my coffee order"],
      ["Together, we could", "Adopt a dog and argue about the name"],
      ["Green flags I look for", "You text 'home safe?'"],
      ["My simple pleasures", "Fresh sheets and a long nap"],
    ],
    spicy: [
      ["The way to win me over is", "Confidence, and knowing what you want"],
      ["I go crazy for", "Late night texts that turn into a late night"],
      ["Together, we could", "Skip dinner and go straight to dessert"],
      ["The way to win me over is", "Confidence in the bedroom"],
      ["Dating me is like", "Netflix and not much watching"],
      ["I'm looking for", "Someone who keeps it spicy after the first date"],
      ["I'm looking for", "Someone with no limits and a safeword"],
      ["Together, we could", "Break the bed frame"],
      ["I go crazy for", "Morning sex and coffee after"],
      ["We'll get along if", "You're loud and proud about it"],
      ["Typical Sunday", "Never leaving the bed"],
      ["Green flags I look for", "You ask what I like, then you remember"],
    ],
  },
];
const MALE_RE = /\b(?:daddy|guy|man|men|dude|king|husband|himbo|boyfriend|bf|him|he|abb|boy)\b/i;
const MATCH_PROMPTS_SHOWN = 3;

/** Pure: the made-up profile for a "find me" request. `rand` is injectable for tests. */
export function buildMatchProfile(query, rand = Math.random, nsfw = false) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const type = MATCH_TYPES.find((t) => t.re.test(query));
  const pool = nsfw ? [...type.prompts, ...type.spicy] : [...type.prompts];
  const prompts = [];
  // NSFW on: the first prompt is always a spicy one, the rest come from the combined pool.
  if (nsfw) prompts.push(pool.splice(type.prompts.length + Math.floor(rand() * type.spicy.length), 1)[0]);
  // Draw without replacement, skipping a prompt question already on the card.
  while (prompts.length < MATCH_PROMPTS_SHOWN && pool.length) {
    const next = pool.splice(Math.floor(rand() * pool.length), 1)[0];
    if (!prompts.some(([q]) => q === next[0])) prompts.push(next);
  }
  return {
    name: pick(MALE_RE.test(query) ? type.m : type.f),
    age: 21 + Math.floor(rand() * 15), // 21–35
    prompts,
    compat: 60 + Math.floor(rand() * 40),
  };
}

export const RAID_OUTPOST_LOST_RE = /\(!\)\s+([A-Za-z0-9_]+)\s+have lost the Raid Outpost,\s+as they have held control for 12 hours!/i;

// Two built-in chat parsers, selected by name from the wall_chat_pattern setting.
//
// `dm` — only private messages sent TO the bot. Leading server/world tags are skipped, then
// `[sender -> me] message`. This deliberately does NOT match public chat, so a stray "check"
// in faction chat can't register; a player has to message the bot on purpose. It also can't
// match the bot's own outgoing whispers, which read `[me -> sender] ...`.
export const DM_CHAT_PATTERN = '^(?:\\[[^\\]]*\\]\\s*)*\\[\\s*(\\w{3,16})\\s*->\\s*(?:me|you)\\s*\\]\\s*(.*)$';

// `chat` — public/faction chat: optional bracketed tags, an optional rank word, then
// `Name: message` or `Name > message`. Deliberately loose, since formats vary a lot.
export const PUBLIC_CHAT_PATTERN = '^(?:\\[[^\\]]*\\]\\s*)*(?:\\S+\\s+)??(\\w{3,16})\\s*[:>]\\s*(.*)$';

// Blank setting = private messages only. Triggers should be a deliberate act, not something
// anyone can fire by mentioning a word in chat.
export const DEFAULT_CHAT_PATTERN = DM_CHAT_PATTERN;

const NAMED_PATTERNS = {
  dm: DM_CHAT_PATTERN,
  chat: PUBLIC_CHAT_PATTERN,
  public: PUBLIC_CHAT_PATTERN,
};

// ---- pure helpers (exported for tests) ----

/** Minecraft names are case-preserving but not case-sensitive — key everything off this. */
export function normalizePlayer(name) {
  return String(name ?? '').trim().toLowerCase();
}

/** 32 lowercase hex, no dashes — the one shape every UUID is stored in. */
export function cleanUuid(uuid) {
  return String(uuid ?? '').replace(/-/g, '').toLowerCase();
}

/**
 * Wall check board for Discord: a monospace table, because inline embed fields collapse into one
 * column on mobile. `sort` is walls | raid | total; ties fall back to name so the order is stable.
 */
export const BOARD_SORTS = {
  total: { label: 'total checks', key: (r) => r.checks + r.raid_checks },
  walls: { label: 'wall checks', key: (r) => r.checks },
  raid: { label: 'raid checks', key: (r) => r.raid_checks },
};
export function banEmbed(b) {
  const t = (ms, style) => `<t:${Math.floor(ms / 1000)}:${style}>`;
  return {
    color: COLOR_ALERT,
    author: {
      name: `${b.player} was banned`, icon_url: HEAD_URL(b.player),
      url: BAN_LOOKUP_URL(b.player),
    },
    fields: [
      { name: 'Reason', value: [b.rules.join(', '), titleCase(b.reason)].filter(Boolean).join(' — ') || 'n/a' },
      // <t:…:R> is rendered live by each viewer's Discord, so it counts down on its own.
      { name: 'Duration', value: b.expiresAt ? `${titleCase(b.duration)} · Ends ${t(b.expiresAt, 'R')}` : titleCase(b.duration) || 'Permanent', inline: true },
      { name: 'Banned', value: t(b.at, 'f'), inline: true },
    ],
  };
}

export function unbanEmbed(b, now = Date.now()) {
  const t = (ms, style) => `<t:${Math.floor(ms / 1000)}:${style}>`;
  return {
    color: COLOR_OK,
    author: {
      name: `${b.player} was unbanned`, icon_url: HEAD_URL(b.player),
      url: BAN_LOOKUP_URL(b.player),
    },
    fields: [
      { name: 'Was', value: [b.rules.join(', '), titleCase(b.reason)].filter(Boolean).join(' — ') || 'n/a' },
      { name: 'Duration', value: titleCase(b.duration) || 'Permanent', inline: true },
      { name: 'Banned', value: t(b.at, 'f'), inline: true },
      { name: 'Noticed', value: t(now, 'R'), inline: true },
    ],
  };
}

const banKey = (b) => `${b.player.toLowerCase()}@${b.at}`;

/**
 * Merge the bans page (20 newest, newest first) into the ledger of bans we know are active.
 * `fresh`: on the page, not in the ledger (oldest first) — post these. `vanished`: in the ledger, off
 * the page — the page alone can't say why (lifted, pushed off the bottom, replaced by a re-ban), so
 * these go to the player's lookup page, longest-unchecked first. Bans past their end or older than
 * BAN_TRACK_MS leave the ledger silently.
 */
export function diffBans(ledger, page, now = Date.now()) {
  const known = new Set(ledger.map(banKey));
  const onPage = new Set(page.map(banKey));
  const fresh = page.filter((b) => !known.has(banKey(b))).reverse();
  const kept = ledger.filter((b) => (!b.expiresAt || b.expiresAt > now) && b.at > now - BAN_TRACK_MS);
  const vanished = kept.filter((b) => !onPage.has(banKey(b)))
    .sort((a, b) => (a.checkedAt || 0) - (b.checkedAt || 0));
  return { fresh, vanished, ledger: [...kept, ...fresh] };
}

/** What a player's lookup page says about one ban: 'unbanned' | 'expired' | 'active', or null if it isn't listed. */
export function banStatus(lookupRows, ban) {
  const row = lookupRows.find((r) => banKey(r) === banKey(ban));
  return row ? row.status || 'active' : null;
}

export function formatCheckBoard(rows, sort = 'total', limit = 25) {
  if (!rows.length) return 'No checks recorded yet.';
  const { key } = BOARD_SORTS[sort] || BOARD_SORTS.total;
  const top = [...rows].sort((a, b) => key(b) - key(a) || a.player.localeCompare(b.player)).slice(0, limit);
  const w = Math.max(6, ...top.map((r) => r.player.length));
  const n = (v) => String(v).padStart(5);
  const lines = [`  #  ${'Player'.padEnd(w)}  ${n('Walls')}  ${n('Raid')}  ${n('Total')}`];
  top.forEach((r, i) => {
    lines.push(`${String(i + 1).padStart(3)}  ${r.player.padEnd(w)}  ${n(r.checks)}  ${n(r.raid_checks)}  ${n(r.checks + r.raid_checks)}`);
  });
  return '```\n' + lines.join('\n') + '\n```';
}

// name (lowercased) -> { uuid, at }. Misses are cached too ('' = Mojang has no such name, e.g. a
// nickname), so one player can't make us hit the API on every message.
const uuidCache = new Map();

async function fetchMojangUuid(name) {
  let uuid = '';
  try {
    const res = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`,
      { signal: AbortSignal.timeout(UUID_LOOKUP_TIMEOUT_MS) });
    if (res.ok) uuid = cleanUuid((await res.json()).id);
  } catch {
    return ''; // network trouble: don't cache, try again next message
  }
  uuidCache.set(normalizePlayer(name), { uuid, at: Date.now() });
  return uuid;
}

// The real capitalization of a name, from Mojang: by UUID when we have one, else by name. null on
// any miss (nickname, renamed since, network trouble), or when the answer isn't the same name.
export async function mojangName(name, uuid = '') {
  const url = uuid ? `https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`
    : `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(UUID_LOOKUP_TIMEOUT_MS) });
    const real = res.ok ? (await res.json()).name : null;
    return real && real.toLowerCase() === name.toLowerCase() ? real : null;
  } catch {
    return null;
  }
}

/** Fill display_name for stats/roster rows that don't have one yet. Sequential, to stay polite to Mojang. */
export async function backfillDisplayNames() {
  for (const row of missingDisplayNames.all()) {
    const real = (row.uuid && await mojangName(row.player, row.uuid)) || await mojangName(row.player);
    if (real) setDisplayName(real, row.user_id, row.player);
  }
}

/** Capitalize each word's first letter, after a space, slash, dash or bracket ("don't" stays). */
export const titleCase = (s) => s.replace(/(^|[\s/(\[-])([a-z])/g, (_, pre, c) => pre + c.toUpperCase());

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#039': "'", '#39': "'", '#x27': "'", nbsp: ' ' };
const cellText = (html) => html.replace(/<[^>]+>/g, ' ')
  .replace(/&(amp|lt|gt|quot|#0?39|#x27|nbsp);/g, (_, e) => ENTITIES[e]).replace(/\s+/g, ' ').trim();

/**
 * Rows of the site's bans table, newest first: { at, player, rules, reason, duration, expiresAt }.
 * `at`/`expiresAt` are ms from the cells' data-utc attributes; expiresAt is 0 for "Never".
 */
export function parseBans(html) {
  const body = /<tbody[^>]*>([\s\S]*?)<\/tbody>/i.exec(html)?.[1] || '';
  return body.split(/<\/tr>/i).map((row) => {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (cells.length < 5) return null;
    const utc = (cell) => Date.parse(/data-utc="([^"]+)"/.exec(cell)?.[1]) || 0;
    return {
      at: utc(cells[0]),
      player: cellText(cells[1]),
      rules: [...cells[2].matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => cellText(m[1])),
      reason: cellText(cells[2].replace(/<a[\s\S]*?<\/a>/gi, '')),
      duration: cellText(cells[3]),
      expiresAt: utc(cells[4]),
      // Lookup page only: the Expires cell carries "Unbanned …" or "Expired …" once a ban has ended.
      status: /Unbanned/i.test(cells[4]) ? 'unbanned' : /Expired/i.test(cells[4]) ? 'expired' : '',
    };
  }).filter((b) => b && b.at && /^\w{1,16}$/.test(b.player));
}

/** Drop legacy section-sign color codes so they can't break the chat pattern. */
export function stripFormatting(text) {
  return String(text ?? '').replace(/§./g, '');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// `/pattern/flags` → RegExp, else treat the whole string as a pattern body.
function toRegExp(source, extraFlags = '') {
  const slash = /^\/(.*)\/([a-z]*)$/s.exec(source);
  const body = slash ? slash[1] : source;
  let flags = slash ? slash[2] : '';
  for (const f of extraFlags) if (!flags.includes(f)) flags += f;
  return new RegExp(body, flags);
}

const patternCache = new Map();
function compilePattern(pattern) {
  const raw = String(pattern ?? '').trim();
  // Accept the friendly names "dm" / "chat" as well as a raw regex, so the common cases don't
  // require anyone to write one.
  const key = NAMED_PATTERNS[raw.toLowerCase()] || raw || DEFAULT_CHAT_PATTERN;
  if (patternCache.has(key)) return patternCache.get(key);
  let re;
  try {
    // Case-insensitive so "-> me" / "-> You" and rank tags of any casing all match.
    re = toRegExp(key, 'i');
  } catch {
    // A user-supplied pattern that doesn't compile falls back to the built-in one rather than
    // throwing from inside the chat handler, which would kill the listener for every later line.
    try { re = new RegExp(DEFAULT_CHAT_PATTERN, 'i'); } catch { re = null; }
  }
  patternCache.set(key, re);
  return re;
}

/**
 * Split a server chat line into who said it and what they said.
 * Returns null when the line doesn't look like player chat (server broadcasts, join messages…).
 */
export function parseChatLine(text, pattern) {
  const raw = stripFormatting(text).trim();
  if (!raw) return null;
  const re = compilePattern(pattern);
  if (!re) return null;
  let m;
  try { m = re.exec(raw); } catch { return null; }
  if (!m || !m[1]) return null;
  return { player: m[1], message: String(m[2] ?? '').trim() };
}

/**
 * Build a matcher from a trigger setting. Accepts either a comma-separated word list
 * (`check, checked, walls`) matched on whole-word boundaries, or a `/regex/flags` literal.
 * A regex that doesn't compile falls back to reading the value as a word list.
 * Always case-insensitive. An empty setting matches nothing.
 */
export function compileTriggers(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return () => false;

  if (/^\/.*\/[a-z]*$/s.test(raw)) {
    try {
      const re = toRegExp(raw, 'i');
      return (message) => re.test(String(message ?? ''));
    } catch { /* not a usable regex — fall through and read it as a word list */ }
  }

  const words = raw.split(',').map((w) => w.trim()).filter(Boolean);
  if (!words.length) return () => false;
  // Hand-rolled boundaries instead of \b so trigger words containing punctuation still work.
  const re = new RegExp(`(?:^|[^\\w])(?:${words.map(escapeRegExp).join('|')})(?![\\w])`, 'i');
  return (message) => re.test(String(message ?? ''));
}

function parseHHMM(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Is `now` inside the quiet window? Times are `HH:MM` in server local time. Either bound blank
 * (or malformed) disables quiet hours entirely. Handles windows that wrap midnight.
 */
export function isQuietHours(now, start, end) {
  const s = parseHHMM(start);
  const e = parseHHMM(end);
  if (s === null || e === null || s === e) return false;
  const d = now instanceof Date ? now : new Date(now);
  const mins = d.getHours() * 60 + d.getMinutes();
  return s < e ? (mins >= s && mins < e) : (mins >= s || mins < e);
}

/** "6h 59m 26s" — the largest non-zero unit downward, so short gaps stay readable. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

/** "2026/07/14 14:45:37" in the panel server's timezone — the same clock as quiet hours. */
export function formatClock(date) {
  const d = date instanceof Date ? date : new Date(date);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * A Discord role ID from the ping setting. Accepts the bare ID or the copied mention form
 * `<@&123…>`. Anything else returns null, so a typo never turns into a stray ping.
 */
export function parseRoleId(value) {
  const m = /^\s*(?:<@&)?(\d{5,25})>?\s*$/.exec(String(value ?? ''));
  return m ? m[1] : null;
}

/** "5m" / "500k" / "1.5b" / "$5,000,000" -> whole dollars, or null. */
export function parseTaxAmount(value) {
  const m = /^\$?(\d+(?:\.\d+)?)\s*([kmb])?$/i.exec(String(value ?? '').replace(/,/g, '').trim());
  if (!m) return null;
  const n = Math.round(Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]?.toLowerCase()] || 1));
  return n > 0 && Number.isSafeInteger(n) ? n : null;
}

/** "24hr" / "12h" / "2d" / "90m" -> ms, or null. A bare number is hours. 1 minute to 30 days. */
export function parseTaxDuration(value) {
  const m = /^(\d+(?:\.\d+)?)\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?)?$/i.exec(String(value ?? '').trim());
  if (!m) return null;
  const unit = (m[2] || 'h')[0].toLowerCase();
  const ms = Math.round(Number(m[1]) * { m: 60000, h: HOUR_MS, d: 24 * HOUR_MS }[unit]);
  return ms >= TAX_MIN_MS && ms <= TAX_MAX_MS ? ms : null;
}

export function formatMoney(n) {
  return `$${Number(n).toLocaleString('en-US')}`;
}

/** Six-digit confirmation code. randomInt, not Math.random — this is a credential. */
export function generateCode() {
  return String(crypto.randomInt(100000, 1000000));
}

/**
 * Substitute `{name}` placeholders in a message template. An unknown placeholder is left
 * untouched rather than blanked, so a literal brace in a message survives intact.
 */
export function fillPlaceholders(text, values) {
  return String(text ?? '').replace(/\{(\w+)\}/g, (whole, key) => (
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole
  ));
}

// ---- the bot ----

/**
 * Wall-check reminders, in-chat check tracking, player verification, and raid alerts for one
 * designated account per user. Owned by BotManager, which feeds it every chat line the wall
 * account sees and supplies `resolveSession` to find that account's live BotSession.
 */
export default class WallBot {
  constructor({ emitToUser, resolveSession }) {
    this.emitToUser = emitToUser;         // (userId, message) => void
    this.resolveSession = resolveSession; // (userId) => BotSession | null
    this.users = new Map();               // userId -> runtime state
    this._tickTimer = setInterval(() => this._tick(), TICK_MS);
    this._stateFor(DEFAULT_USER_ID); // so _tick sees a persisted tax right after a restart
    backfillDisplayNames(); // fire and forget: roster names in their real case
  }

  stopAll() {
    clearInterval(this._tickTimer);
    for (const state of this.users.values()) {
      clearInterval(state.raidTimer);
      clearTimeout(state.sendTimer);
      clearTimeout(state.banTimer);
    }
    this.users.clear();
  }

  _stateFor(userId) {
    let state = this.users.get(userId);
    if (state) return state;
    const row = getWallState.get(userId);
    state = {
      wallActive: false,
      raidActive: false,
      lastCheckAt: row?.last_check_at || 0,
      totalChecks: row?.total_checks || 0,
      lastReminderAt: 0,         // when we last reminded about walls, kept apart from lastCheckAt
      lastRaidReminderAt: 0,     // same for the outpost — own clock, so neither holds the other back
      wasQuiet: false,           // were walls paused (quiet hours or grace) on the previous tick?
      quietEndedAt: 0,           // when the pause last lifted; restarts the unchecked count
      // Raid Outpost: IDLE → CLAIMED_GRACE → COOLDOWN → ACTIVE_CHECKING → IDLE. Persisted.
      raidOutpostState: row?.raid_outpost_state || 'IDLE',
      raidOutpostHolder: row?.raid_outpost_holder || '', // last faction seen claiming it; '' = unknown
      raidOutpostClaimedAt: row?.raid_outpost_claimed_at || 0,
      lastRaidCheckAt: row?.last_raid_check_at || 0,
      raidStartedAt: 0,          // when the current raid alert began, for "time since alert"
      raidTimer: null,
      cooldowns: new Map(),      // `${kind}:${player}` -> ts of last counted check
      notices: new Map(),        // player -> ts of last "please verify" reply
      verifyAttempts: new Map(), // player -> [ts, ...] of wrong password/code guesses this hour
      displayNames: new Map(),   // lowercased player -> name as the server spelled it
      uuids: new Map(),          // lowercased player -> UUID linked this session
      pendingCodes: new Map(),   // player -> { code, expiresAt } awaiting confirmation
      reportRequests: new Map(), // player -> [ts, ...] of report links issued this hour
      matchRequests: new Map(),  // player -> [ts, ...] of "find me" cards posted this hour
      banTimer: null,            // pending bans-page fetch after a Shiva line
      banBusy: false,            // a bans-page sync is in flight
      lastBanPollAt: 0,          // last periodic bans-page sync
      queue: [],                 // pending outbound messages
      sendTimer: null,
      lastSentAt: 0,
      recentSent: [],            // our own recent message bodies, for echo suppression
    };
    this.users.set(userId, state);
    return state;
  }

  // ---- panel-driven controls ----

  wallStart(userId) {
    const settings = getSettings.get(userId);
    if (!settings?.wall_enabled) {
      this._error(userId, 'Wall bot is disabled — turn it on in Settings first.');
      return;
    }
    const state = this._stateFor(userId);
    if (state.wallActive) return;
    state.wallActive = true;
    state.lastCheckAt = Date.now();
    this._persist(userId, state);
    this._console(userId, 'Wall checks started.');
    this.broadcast(userId);
  }

  wallEnd(userId) {
    const state = this._stateFor(userId);
    if (!state.wallActive) return;
    state.wallActive = false;
    this._console(userId, 'Wall checks stopped.');
    this.broadcast(userId);
  }

  raidStart(userId) {
    const settings = getSettings.get(userId);
    if (!settings?.raid_enabled) {
      this._error(userId, 'Weewoo alerts are disabled — turn them on in Settings first.');
      return;
    }
    this._beginRaid(userId, settings, null);
  }

  raidStop(userId) {
    this._endRaid(userId, null);
  }

  /**
   * Panel override for the Raid Outpost state, for when a broadcast was missed or misread. Chat
   * broadcasts keep driving it from wherever this leaves it. No Discord notice: the operator
   * already knows, and a hand-set state isn't news about who holds the outpost.
   */
  setRaidOutpost(userId, key) {
    const next = { idle: 'IDLE', claimed: 'CLAIMED_GRACE', cooldown: 'COOLDOWN', live: 'ACTIVE_CHECKING' }[key];
    if (!next) return;
    const settings = getSettings.get(userId);
    const faction = normalizePlayer(settings?.raid_outpost_faction);
    const state = this._stateFor(userId);
    const now = Date.now();
    if (next === 'IDLE') {
      this._resetRaidOutpost(state);
      state.raidOutpostHolder = '';
    } else {
      if (state.raidOutpostState === 'IDLE' || next === 'CLAIMED_GRACE') state.raidOutpostClaimedAt = now;
      if (next === 'ACTIVE_CHECKING' && state.raidOutpostState !== 'ACTIVE_CHECKING') {
        state.lastRaidCheckAt = now;
        state.lastRaidReminderAt = 0;
      }
      state.raidOutpostState = next;
      state.raidOutpostHolder = faction;
    }
    this._console(userId, `Raid Outpost set to ${key} from the panel.`);
    this._persist(userId, state);
    this.broadcast(userId);
  }

  /**
   * Credit a check from the panel rather than from chat. Deliberately not gated by quiet hours:
   * the panel is the operator, and an override is the point of having a button. In-game triggers
   * are the ones that get refused.
   */
  manualCheck(userId, player) {
    const settings = getSettings.get(userId);
    const name = normalizePlayer(player) || 'panel';
    this._countCheck(userId, settings, name, { kind: 'wall', announce: !!settings?.wall_enabled });
  }

  // ---- chat intake ----

  /**
   * Called by BotManager for every chat line seen by a bot. Ignores everything that isn't the
   * designated wall account, so other bots' chat never double-counts.
   */
  handleChat(userId, session, text) {
    const settings = getSettings.get(userId);
    if (!settings?.wall_enabled) return;
    const wallSession = this.resolveSession(userId);
    if (!wallSession || wallSession !== session) return;

    // Server broadcasts first — they aren't player chat, so parseChatLine would drop them.
    this._handleShiva(userId, settings, stripFormatting(text)); // no return: a DM can say "shiva"
    if (this._handleRaidOutpost(userId, settings, stripFormatting(text))) return;

    const parsed = parseChatLine(text, settings.wall_chat_pattern);
    if (!parsed) return;

    const player = normalizePlayer(parsed.player);
    const message = parsed.message;
    if (!player || !message) return;
    if (this._isSelf(userId, session, player, message)) return;
    // Stats key off the lowercased name, but some network /msg plugins match the target
    // case-sensitively: they echo `[me -> name]` and then deliver nothing. Reply as spelled.
    const spelled = parsed.player.trim();
    this._stateFor(userId).displayNames.set(player, spelled);

    // Tie the name to its UUID before anything counts, so a renamed player's checks land on
    // their existing row. Tab list first (free); Mojang only for someone on another server.
    if (this._isOnlineMode(session)) {
      const tab = Object.values(session.bot.players || {}).find((p) => normalizePlayer(p.username) === player);
      const cached = uuidCache.get(player);
      const known = tab?.uuid ? cleanUuid(tab.uuid)
        : cached && Date.now() - cached.at < UUID_CACHE_MS ? cached.uuid : null;
      if (known === null) {
        fetchMojangUuid(spelled).then((uuid) => {
          if (uuid) this._linkUuid(userId, player, uuid);
          this._dispatchChat(userId, getSettings.get(userId), player, message);
        });
        return;
      }
      if (known) this._linkUuid(userId, player, known);
    }
    this._dispatchChat(userId, settings, player, message);
  }

  // Offline-mode servers hand out name-derived v3 UUIDs; names are the identity there anyway, and
  // mixing those with Mojang's v4 ids would split players. So UUID tracking needs a v4 bot.
  _isOnlineMode(session) {
    const own = cleanUuid(session?.bot?.player?.uuid);
    return own.length === 32 && own[12] === '4';
  }

  _linkUuid(userId, player, uuid) {
    const state = this._stateFor(userId);
    if (state.uuids.get(player) === uuid) return;
    state.uuids.set(player, uuid);
    const renamed = linkPlayerUuid(userId, uuid, player);
    if (renamed.length) {
      this._console(userId, `${renamed[0]} changed their name to ${player}; their checks moved with them.`);
      this.broadcast(userId);
    }
  }

  _dispatchChat(userId, settings, player, message) {
    if (!settings?.wall_enabled) return;
    this._rememberCase(userId, player);
    if (this._handleVerify(userId, settings, player, message)) return;
    if (this._handleReport(userId, settings, player, message)) return;
    if (this._handleMatch(userId, settings, player, message)) return;
    if (this._handleTax(userId, settings, player, message)) return;
    if (this._handleRaidTriggers(userId, settings, player, message)) return;
    this._handleCheckTrigger(userId, settings, player, message);
  }

  // The server's spelling is the real case; keeps display_name current on any row this player has.
  _rememberCase(userId, player) {
    const spelled = this._stateFor(userId).displayNames.get(player);
    if (spelled) setDisplayName(spelled, userId, player);
  }

  // Our own messages come back through chat. Without this the reminder would satisfy its own
  // trigger and the bot would talk to itself forever.
  _isSelf(userId, session, player, message) {
    const botName = normalizePlayer(session?.bot?.username || session?.account?.username);
    if (botName && player === botName) return true;
    const state = this._stateFor(userId);
    return state.recentSent.some((sent) => message.includes(sent));
  }

  /**
   * Two-step self-verification, both steps over private message:
   *   1. `verify <password>` — the shared faction password from the panel. Correct, and the bot
   *      whispers back a random 6-digit code that lives for 15 minutes.
   *   2. `verify <code>` — confirms, and the sender lands on the roster.
   *
   * The code is bound to the player it was issued to, so knowing someone else's code is useless:
   * the lookup is keyed by whoever sent the message, and the server is what decides that name.
   */
  _handleVerify(userId, settings, player, message) {
    const m = /^\s*verify\b\s*(.*)$/i.exec(message);
    if (!m) return false;

    const supplied = m[1].trim();
    const password = String(settings.wall_verify_password || '').trim();
    const state = this._stateFor(userId);
    const now = Date.now();

    if (this._isAuthorized(userId, settings, player)) {
      this._whisper(userId, player, 'You are already verified.');
      return true;
    }

    // No password set = self-verification is closed, rather than open to everyone. Failing
    // shut matters here: the alternative would quietly let any passer-by onto the roster.
    if (!password) {
      this._whisper(userId, player, 'Self-verification is disabled. Ask an admin to add you.');
      return true;
    }

    // Asking without an argument is a help request, not a guess — don't spend an attempt on it.
    if (!supplied) {
      this._whisper(userId, player, 'Message me "verify <password>" with the faction password.');
      return true;
    }

    // Drop a stale code before anything else, so an expired one can't be completed and the
    // password path issues a fresh one.
    let pending = state.pendingCodes.get(player);
    if (pending && pending.expiresAt <= now) {
      state.pendingCodes.delete(player);
      pending = null;
    }

    const attempts = (state.verifyAttempts.get(player) || []).filter((ts) => now - ts < HOUR_MS);
    if (attempts.length >= VERIFY_MAX_PER_HOUR) {
      state.verifyAttempts.set(player, attempts);
      this._whisper(userId, player, 'Too many attempts. Try again later.');
      return true;
    }

    // Step 2: completing with a live code. Checked before the password so that a password which
    // happens to be six digits still can't be confused with a code.
    if (pending && supplied === pending.code) {
      state.pendingCodes.delete(player);
      state.verifyAttempts.delete(player);
      upsertWallPlayer.run({
        user_id: userId, player, uuid: state.uuids.get(player) || '', verified: 1, label: '', added_at: now,
      });
      this._whisper(userId, player, 'Verified — your wall checks will now be counted.');
      this._console(userId, `${player} verified.`);
      this.broadcast(userId);
      return true;
    }

    // Step 1: correct password issues a code. Re-sending the password while one is still live
    // repeats the same code rather than minting a new one, so a lost whisper isn't a dead end
    // and nobody can spam themselves a stream of codes.
    if (supplied === password) {
      if (!pending) {
        pending = { code: generateCode(), expiresAt: now + CODE_TTL_MS };
        state.pendingCodes.set(player, pending);
        this._console(userId, `Verification code issued to ${player}.`);
      }
      const mins = Math.max(1, Math.round((pending.expiresAt - now) / 60000));
      this._whisper(userId, player, `Your code is ${pending.code} — message me "verify ${pending.code}" within ${mins} minute${mins === 1 ? '' : 's'}.`);
      return true;
    }

    attempts.push(now);
    state.verifyAttempts.set(player, attempts);
    const left = VERIFY_MAX_PER_HOUR - attempts.length;
    this._whisper(userId, player, pending ? 'Wrong code.' : 'Wrong password.');
    // Log that it happened, never what was guessed — the console is visible in the panel.
    this._console(userId, `Failed verify attempt from ${player} (${left} left this hour).`);
    return true;
  }

  /**
   * `report` — whisper back a one-time link to the report form (server/report.js). The sender
   * is recorded with the ticket in the panel; Discord only ever sees the ticket number.
   */
  _handleReport(userId, settings, player, message) {
    if (!/^\s*report\b/i.test(message)) return false;
    if (!process.env.PUBLIC_URL || !settings.report_discord_webhook) {
      this._notifyOnce(userId, player, 'Anonymous reports are not set up.');
      return true;
    }
    if (!settings.reports_enabled) {
      this._notifyOnce(userId, player, 'Reports are turned off right now.');
      return true;
    }
    // Reports have their own verified-only switch, independent of the wall bot's. An unverified
    // player gets no reply at all, so the bot doesn't advertise that reports exist.
    const gate = { ...settings, wall_require_verified: settings.reports_verified_only };
    if (!this._isAuthorized(userId, gate, player)) {
      this._console(userId, `Ignored report request from unverified ${player}.`);
      return true;
    }

    const state = this._stateFor(userId);
    const now = Date.now();
    const recent = (state.reportRequests.get(player) || []).filter((ts) => now - ts < HOUR_MS);
    if (recent.length >= REPORT_MAX_PER_HOUR) {
      state.reportRequests.set(player, recent);
      this._notifyOnce(userId, player, 'Too many report links this hour. Try again later.');
      return true;
    }
    recent.push(now);
    state.reportRequests.set(player, recent);
    // Keep this short: the whole `/msg <player> ...` line must fit in 100 characters.
    this._whisper(userId, player, `Report: ${reportUrl(issueReportToken(userId, player, now))}`);
    return true;
  }

  /**
   * `find me a <something>` — verified players only, always (the wall's verified toggle doesn't
   * open it). Unverified players and anything that reads as a minor get no reply at all.
   */
  _handleMatch(userId, settings, player, message) {
    const webhook = settings.match_discord_webhook;
    const query = webhook && parseMatchQuery(message);
    if (!query) return false;
    if (!getWallPlayer.get(userId, player)?.verified) {
      this._console(userId, `Ignored "find me" from unverified ${player}.`);
      return true;
    }
    if (MINOR_RE.test(query)) {
      this._console(userId, `Refused "find me" from ${player}: request reads as a minor.`);
      return true;
    }
    const state = this._stateFor(userId);
    const now = Date.now();
    const recent = (state.matchRequests.get(player) || []).filter((ts) => now - ts < HOUR_MS);
    if (recent.length >= MATCH_MAX_PER_HOUR) {
      state.matchRequests.set(player, recent);
      this._notifyOnce(userId, player, 'Slow down broski, try again later.');
      return true;
    }
    recent.push(now);
    state.matchRequests.set(player, recent);
    this._whisper(userId, player, 'bet that broski');
    this._postMatch(userId, webhook, player, query, !!settings.match_nsfw);
    return true;
  }

  async _postMatch(userId, webhook, player, query, nsfw) {
    const p = buildMatchProfile(query, Math.random, nsfw);
    const shown = this._stateFor(userId).displayNames.get(player) || player;
    await this._postDiscord(userId, webhook, '', {
      color: COLOR_MATCH,
      author: { name: `${shown} is looking for: ${query}`, icon_url: HEAD_URL(shown) },
      title: `💘 ${p.name}, ${p.age}`,
      fields: [
        ...p.prompts.map(([name, value]) => ({ name, value })),
        { name: 'Compatibility', value: `${p.compat}%`, inline: true },
      ],
      thumbnail: { url: HEAD_URL(shown) },
    });
    this._console(userId, `Posted a "find me" card for ${player}: ${query}`);
  }

  // ---- tax ----
  // The bot is an alt and can't receive /pay, so payment is claim + confirm: a player deposits to
  // the main f bank, whispers `paid`, and a tax admin confirms it (in game or in the panel).

  _taxRow(userId) {
    const row = getWallState.get(userId);
    return row?.tax_due_at ? row : null;
  }

  _taxPlayers(userId) {
    return listWallPlayers.all(userId).filter((r) => r.tax);
  }

  _shown(userId, row) {
    return row.display_name || this._stateFor(userId).displayNames.get(row.player) || row.player;
  }

  /** `confirm <x>`: x is the IGN, or the nickname `pending` showed. Nicknames are unique (api.js). */
  _resolveTaxTarget(userId, arg) {
    const key = normalizePlayer(arg);
    if (!key) return null;
    const direct = getWallPlayer.get(userId, key);
    if (direct?.tax) return direct;
    return this._taxPlayers(userId).find((r) => r.label.toLowerCase() === key) || null;
  }

  _handleTax(userId, settings, player, message) {
    const text = message.trim();
    const m = /^(tax|paid|pending|unpaid|confirm|deny)\b\s*(.*)$/i.exec(text);
    if (!m) return false;
    const cmd = m[1].toLowerCase();
    const args = m[2].trim().split(/\s+/).filter((w) => /\w/.test(w));
    const me = getWallPlayer.get(userId, player);
    const admin = !!me?.tax_admin;
    const tax = this._taxRow(userId);

    if (cmd === 'paid') {
      if (args.length) return false; // "paid 5 for that" in a DM isn't a tax claim
      if (!tax) { this._whisper(userId, player, 'No tax is running.'); return true; }
      if (!me?.tax) { this._whisper(userId, player, "You're not on the tax list."); return true; }
      if (me.tax_status === 'paid') { this._whisper(userId, player, 'You already paid this tax.'); return true; }
      if (me.tax_status === 'claimed') { this._whisper(userId, player, 'Still waiting for the IRS to confirm.'); return true; }
      setTaxStatus.run('claimed', userId, player);
      this._whisper(userId, player, 'Got it. waiting for the IRS to confirm.');
      const shown = this._shown(userId, me);
      this._taxLog(userId, settings, `${shown} is waiting on confirmation`);
      this._console(userId, `${shown} says they paid tax; waiting on confirmation.`);
      // Every tax admin hears about it, so a claim never waits on one offline admin.
      for (const a of listWallPlayers.all(userId).filter((r) => r.tax_admin)) {
        this._whisper(userId, a.player, `${shown} paid? confirm ${shown} / deny ${shown}`);
      }
      this.broadcast(userId);
      return true;
    }

    if (cmd === 'tax' && (!args.length || args[0].toLowerCase() === 'status')) {
      if (!tax) { this._whisper(userId, player, 'No tax is running.'); return true; }
      if (!me?.tax && !admin) return true;
      const hours = Math.max(0, Math.ceil((tax.tax_due_at - Date.now()) / HOUR_MS));
      const status = !me?.tax ? '' : ` You: ${me.tax_status === 'paid' ? 'paid' : me.tax_status === 'claimed' ? 'awaiting confirmation' : 'not paid'}.`;
      this._whisper(userId, player, `Tax: ${formatMoney(tax.tax_amount)}, due in ${hours}h.${status}`);
      return true;
    }

    // Everything below is admin-only. Non-admins get no reply, so the commands aren't advertised.
    if (!admin) {
      this._console(userId, `Ignored "${cmd}" from ${player}: not a tax admin.`);
      return true;
    }

    const sub = cmd === 'tax' ? args[0].toLowerCase() : cmd;
    if (sub === 'pending' || sub === 'unpaid') {
      // The one place nicknames show: these lists can run long. Everything else uses the IGN.
      // `unpaid` is everyone not confirmed yet, claimed included, so it matches the overdue list.
      if (sub === 'unpaid' && !tax) { this._whisper(userId, player, 'No tax is running.'); return true; }
      const waiting = this._taxPlayers(userId)
        .filter((r) => (sub === 'pending' ? r.tax_status === 'claimed' : r.tax_status !== 'paid'))
        .map((r) => r.label || this._shown(userId, r));
      if (!waiting.length) {
        this._whisper(userId, player, sub === 'pending' ? 'Nobody is waiting on confirmation.' : 'Everyone has paid.');
        return true;
      }
      // Nicknames, comma-only separators, packed to the chat limit: the whole
      // `/msg <admin> ...` line must fit in 100 characters. Only a list that still overflows splits.
      const cmdLen = String(settings.wall_msg_command || '/msg').trim().length;
      const room = 100 - cmdLen - 2 - this._shown(userId, me).length;
      const head = `${sub === 'pending' ? 'Waiting' : 'Unpaid'} (${waiting.length}):`;
      let line = head;
      for (const name of waiting) {
        if (line !== head && line.length + name.length + 1 > room) { this._whisper(userId, player, line); line = '+'; }
        line += `${line === head || line === '+' ? ' ' : ','}${name}`;
      }
      this._whisper(userId, player, line);
      return true;
    }

    if (cmd === 'tax' && args[0].toLowerCase() === 'end') {
      if (!tax) { this._whisper(userId, player, 'No tax is running.'); return true; }
      this.endTax(userId, this._shown(userId, me));
      this._whisper(userId, player, 'Tax ended.');
      return true;
    }

    if (cmd === 'tax') {
      if (tax) { this._whisper(userId, player, 'Error: Ongoing Tax'); return true; }
      const amount = parseTaxAmount(args[0]);
      const duration = parseTaxDuration(args.slice(1).join(''));
      if (!amount || !duration) { this._whisper(userId, player, 'Usage: tax <amount> <time>, e.g. tax 5m 24hr'); return true; }
      this._whisper(userId, player, 'Starting tax collection.');
      this.startTax(userId, amount, duration, player);
      return true;
    }

    // confirm / deny <player>
    const row = this._resolveTaxTarget(userId, args[0]);
    const target = row?.player;
    if (!row?.tax) { this._whisper(userId, player, `Usage: ${cmd} <player on the tax list>`); return true; }
    // Every admin is told about a claim, so a second admin's confirm/deny usually lands after the
    // first one settled it. Refuse those, or each admin re-logs (or flips) the same payment.
    if (row.tax_status === 'paid') { this._whisper(userId, player, `${this._shown(userId, row)} is already confirmed.`); return true; }
    if (cmd === 'deny' && row.tax_status !== 'claimed') { this._whisper(userId, player, `${this._shown(userId, row)} hasn't claimed a payment.`); return true; }
    if (cmd === 'confirm') this.confirmTax(userId, target, this._shown(userId, me));
    else this.denyTax(userId, target, this._shown(userId, me));
    this._whisper(userId, player, `${cmd === 'confirm' ? 'Confirmed' : 'Denied'} ${this._shown(userId, row)}.`);
    return true;
  }

  /** Start a tax. Returns false when one is already running. `by` is a player key or 'panel'. */
  startTax(userId, amount, durationMs, by = 'panel') {
    if (this._taxRow(userId)) {
      this._error(userId, 'Error: Ongoing Tax');
      return false;
    }
    const now = Date.now();
    resetTaxStatuses.run(userId); // a new tax puts everyone back to not paid
    saveTax.run({
      user_id: userId, tax_amount: amount, tax_started_at: now, tax_due_at: now + durationMs,
      tax_last_reminder_at: now, tax_started_by: by,
    });
    const tax = this._taxRow(userId);
    const starter = by === 'panel' ? 'the panel' : (this._stateFor(userId).displayNames.get(by) || by);
    this._console(userId, `Tax of ${formatMoney(amount)} started by ${starter}, due in ${formatDuration(durationMs)}.`);
    this._postTax(userId, tax, 'start', this._taxPlayers(userId), `Started by ${starter}`);
    this.broadcast(userId);
    return true;
  }

  endTax(userId, by = 'the panel') {
    const tax = this._taxRow(userId);
    if (!tax) return;
    clearTax.run(userId);
    this._console(userId, `Tax ended early by ${by}.`);
    this._postTax(userId, tax, 'end', [], `Ended early by ${by}`);
    this.broadcast(userId);
  }

  confirmTax(userId, player, by = 'panel') {
    const row = getWallPlayer.get(userId, normalizePlayer(player));
    if (!row?.tax || row.tax_status === 'paid') return; // already settled: don't log it twice
    setTaxStatus.run('paid', userId, row.player);
    const shown = this._shown(userId, row);
    this._whisper(userId, row.player, 'Your tax payment was confirmed.');
    this._taxLog(userId, getSettings.get(userId), `${shown}'s payment accepted by ${by}`);
    this._console(userId, `${shown}'s tax payment accepted by ${by}.`);
    this.broadcast(userId);
  }

  denyTax(userId, player, by = 'panel') {
    const row = getWallPlayer.get(userId, normalizePlayer(player));
    if (!row?.tax || row.tax_status !== 'claimed') return; // nothing to deny (or already confirmed)
    setTaxStatus.run('', userId, row.player);
    const shown = this._shown(userId, row);
    this._whisper(userId, row.player, 'Your tax payment wasn\'t confirmed. Pay and message me "paid" again.');
    this._taxLog(userId, getSettings.get(userId), `${shown}'s payment denied by ${by}`);
    this._console(userId, `${shown}'s tax payment denied by ${by}.`);
    this.broadcast(userId);
  }

  // Every tick, whether or not wall checks are running: 12h reminders, then the overdue post at due.
  _taxTick(userId) {
    const tax = this._taxRow(userId);
    if (!tax) return;
    const now = Date.now();
    if (now >= tax.tax_due_at) {
      clearTax.run(userId);
      const owing = this._taxPlayers(userId).filter((r) => r.tax_status !== 'paid');
      this._console(userId, `Tax is due. ${owing.length} player${owing.length === 1 ? '' : 's'} didn't pay.`);
      this._postTax(userId, tax, 'overdue', owing);
      this.broadcast(userId);
      return;
    }
    if (now - tax.tax_last_reminder_at < TAX_REMINDER_MS) return;
    setTaxReminderAt.run(now, userId);
    this._postTax(userId, tax, 'reminder', this._taxPlayers(userId).filter((r) => r.tax_status === ''));
  }

  /** Announcement in the tax channel. `ping` is the roster rows to @mention by Discord ID. */
  _postTax(userId, tax, kind, ping, footer = '') {
    const settings = getSettings.get(userId);
    const webhook = settings?.tax_discord_webhook || settings?.wall_discord_webhook;
    if (!webhook) return;
    const all = this._taxPlayers(userId);
    const names = (rows) => rows.map((r) => this._shown(userId, r)).join(', ') || 'nobody';
    const due = Math.floor(tax.tax_due_at / 1000);
    const hoursLeft = Math.max(0, Math.ceil((tax.tax_due_at - Date.now()) / HOUR_MS));
    const paid = all.filter((r) => r.tax_status === 'paid').length;
    const claimed = all.filter((r) => r.tax_status === 'claimed');
    const unlinked = ping.filter((r) => !r.discord_id);
    const howTo = 'Deposit to the f bank, then `/msg ' + this._botName(userId) + ' paid`.';
    const embed = {
      start: {
        title: '💰 Tax collection started',
        description: `Everyone on the tax list owes **${formatMoney(tax.tax_amount)}**.\nDue <t:${due}:F> (<t:${due}:R>).\n${howTo}`,
        fields: [{ name: 'Taxed', value: names(all) }],
      },
      reminder: {
        title: `⏰ Tax reminder: ${hoursLeft}h left`,
        description: `**${formatMoney(tax.tax_amount)}** due <t:${due}:R>.\n${howTo}`,
        fields: [
          { name: 'Not paid', value: names(ping) },
          ...(claimed.length ? [{ name: 'Awaiting confirmation', value: names(claimed) }] : []),
          { name: 'Paid', value: `${paid}/${all.length}`, inline: true },
        ],
      },
      overdue: {
        title: '🚨 Tax overdue',
        description: `The ${formatMoney(tax.tax_amount)} tax was due <t:${due}:R>.`,
        fields: [
          { name: 'Did not pay', value: names(ping) },
          { name: 'Paid', value: `${paid}/${all.length}`, inline: true },
        ],
      },
      end: {
        title: 'Tax ended',
        description: `The ${formatMoney(tax.tax_amount)} tax was ended early. ${paid}/${all.length} paid.`,
      },
    }[kind];
    if (unlinked.length && kind !== 'end') embed.fields.push({ name: 'No Discord linked', value: names(unlinked) });
    if (footer) embed.footer = { text: footer };
    const ids = ping.map((r) => r.discord_id).filter(Boolean);
    this._postDiscord(userId, webhook, '', { color: COLOR_TAX, ...embed }, null, ids);
  }

  /** One plain code-block line in the #tax log channel. No embed, no pings. */
  _taxLog(userId, settings, line) {
    const webhook = settings?.tax_log_discord_webhook || settings?.tax_discord_webhook || settings?.wall_discord_webhook;
    if (!webhook) return;
    this._postDiscord(userId, webhook, '```\n' + line.replace(/`/g, "'") + '\n```');
  }

  _handleRaidTriggers(userId, settings, player, message) {
    if (!settings.raid_enabled) return false;

    if (compileTriggers(settings.raid_off_trigger)(message)) {
      if (!this._requireAuthorized(userId, settings, player)) return true;
      this._endRaid(userId, player);
      return true;
    }
    if (compileTriggers(settings.raid_trigger)(message)) {
      if (!this._requireAuthorized(userId, settings, player)) return true;
      this._beginRaid(userId, settings, player);
      return true;
    }
    return false;
  }

  /**
   * Raid Outpost server broadcasts drive a small state machine. It only ever touches outpost
   * fields — the wall loop, `lastCheckAt` and the wall counters carry on regardless.
   * Returns true when the line was one of the broadcasts.
   */
  _handleRaidOutpost(userId, settings, line) {
    const faction = normalizePlayer(settings.raid_outpost_faction);
    const state = this._stateFor(userId);
    const now = Date.now();
    let m;

    if ((m = RAID_OUTPOST_CLAIMED_RE.exec(line))) {
      const by = normalizePlayer(m[1]);
      const wasOurs = !!faction && (state.raidOutpostState !== 'IDLE' || state.raidOutpostHolder === faction);
      state.raidOutpostHolder = by;
      if (faction && by === faction) {
        state.raidOutpostState = 'CLAIMED_GRACE';
        state.raidOutpostClaimedAt = now;
        this._raidOutpostNotice(userId, COLOR_OK, `We claimed the Raid Outpost (${m[1]}).`);
      } else {
        this._resetRaidOutpost(state);
        if (wasOurs) this._raidOutpostNotice(userId, COLOR_ALERT, `${m[1]} took the Raid Outpost from us.`);
        else this._console(userId, `Raid Outpost claimed by ${by}.`);
      }
    } else if (RAID_OUTPOST_COOLDOWN_RE.test(line)) {
      if (state.raidOutpostState === 'CLAIMED_GRACE') {
        state.raidOutpostState = 'COOLDOWN';
      } else if (state.raidOutpostState === 'IDLE' && faction
        && (!state.raidOutpostHolder || state.raidOutpostHolder === faction)) {
        // The claim went by while we were offline. The cooldown line doesn't say whose it is, so
        // assume ours unless we saw someone else take it. A missed hold of our own outpost costs
        // 12 unchecked hours; a wrong guess costs some reminders the panel shows plainly.
        state.raidOutpostState = 'COOLDOWN';
        state.raidOutpostHolder = faction;
        this._console(userId, `Raid Outpost cooldown started but the claim was missed — assuming ${faction} holds it.`);
      } else {
        return true;
      }
      if (state.raidOutpostState === 'COOLDOWN') this._console(userId, 'Raid Outpost on 1 hour cooldown.');
    } else if (RAID_OUTPOST_STARTED_RE.test(line)) {
      if (state.raidOutpostState !== 'CLAIMED_GRACE' && state.raidOutpostState !== 'COOLDOWN') return true;
      state.raidOutpostState = 'ACTIVE_CHECKING';
      state.lastRaidCheckAt = now;
      state.lastRaidReminderAt = 0;
      this._console(userId, 'Raid Outpost is live — raid checks are on.');
    } else if ((m = RAID_OUTPOST_LOST_RE.exec(line))) {
      const by = normalizePlayer(m[1]);
      if (faction && by === faction) {
        this._resetRaidOutpost(state);
        state.raidOutpostHolder = '';
        this._raidOutpostNotice(userId, COLOR_MUTED, 'We lost the Raid Outpost after holding it for 12 hours.');
      } else if (state.raidOutpostHolder === by) {
        state.raidOutpostHolder = '';
      }
    } else {
      return false;
    }
    this._persist(userId, state);
    this.broadcast(userId);
    return true;
  }

  // ---- ban feed ----

  _handleShiva(userId, settings, line) {
    if (!settings.ban_discord_webhook || !SHIVA_RE.test(line)) return;
    const state = this._stateFor(userId);
    if (state.banTimer) return; // a fetch is already queued; it will pick this ban up too
    const attempt = (i) => {
      state.banTimer = setTimeout(async () => {
        const found = await this._syncBans(userId);
        state.banTimer = null;
        if (!found && i + 1 < BAN_FETCH_DELAYS_MS.length) attempt(i + 1);
      }, BAN_FETCH_DELAYS_MS[i]);
    };
    attempt(0);
  }

  /**
   * Read the bans page and post every ban not in the ledger yet (oldest first). Ledger bans that left
   * the page are checked on the player's lookup page: "Unbanned" posts an unban, "Expired" drops it,
   * still active stays tracked. Returns how many new bans were posted. The first sync ever only posts
   * the last BAN_LOOKBACK_MS and records the rest quietly, so it doesn't dump the backlog.
   */
  async _syncBans(userId) {
    const webhook = getSettings.get(userId)?.ban_discord_webhook;
    const state = this._stateFor(userId);
    if (!webhook || state.banBusy) return 0;
    state.banBusy = true;
    const fetchBans = async (url) => {
      const res = await fetch(url, {
        // The site 404s Node fetch's default `Accept-Language: *`; a real locale gets the page.
        headers: { 'User-Agent': 'Mozilla/5.0 (ban feed)', 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseBans(await res.text());
    };
    try {
      let page;
      try {
        page = await fetchBans(BANS_URL);
      } catch (e) {
        this._error(userId, `Bans page fetch failed: ${e.message}`);
        return 0;
      }
      if (!page.length) return 0; // a broken page must not read as every ban vanishing
      const raw = getWallState.get(userId)?.posted_bans || '';
      const now = Date.now();
      // Never synced: pretend everything older than the lookback was already posted.
      const prior = raw ? JSON.parse(raw) : page.filter((b) => b.at <= now - BAN_LOOKBACK_MS);
      const { fresh, vanished, ledger } = diffBans(prior, page, now);
      const unbanned = [];
      for (const b of vanished.slice(0, BAN_LOOKUPS_PER_SYNC)) {
        let status = null;
        try { status = banStatus(await fetchBans(BAN_LOOKUP_URL(b.player)), b); } catch { /* retry next sync */ }
        b.checkedAt = now;
        if (status === 'unbanned') unbanned.push(b);
        if (status === 'unbanned' || status === 'expired') ledger.splice(ledger.indexOf(b), 1);
      }
      setPostedBans.run(userId, JSON.stringify(ledger)); // before posting: a slow post can't double up
      for (const b of fresh) {
        b.player = (await mojangName(b.player)) || b.player;
        this._console(userId, `ban: ${b.player} (${b.duration})`);
        await this._postDiscord(userId, webhook, '', banEmbed(b));
      }
      for (const b of unbanned) {
        this._console(userId, `unban: ${b.player}`);
        await this._postDiscord(userId, webhook, '', unbanEmbed(b, now));
      }
      return fresh.length;
    } finally {
      state.banBusy = false;
    }
  }

  // Ownership changes go to Discord only (Raid Outpost webhook, falling back to wall) — the server
  // already announces them in game, so echoing them into chat would just be noise.
  _raidOutpostNotice(userId, color, text) {
    const settings = getSettings.get(userId);
    this._send(userId, text, {
      channel: 'raid_outpost', minecraft: false, embed: { color, description: `**${text}**` },
      ping: !!settings?.ping_raid_outpost,
    });
  }

  _resetRaidOutpost(state) {
    state.raidOutpostState = 'IDLE';
    state.raidOutpostClaimedAt = 0;
    state.lastRaidCheckAt = 0;
    state.lastRaidReminderAt = 0;
  }

  /**
   * `walls` and `raid` are separate checks that can share one message: "walls raid" logs both.
   * Each kind is refused on its own terms — walls during quiet hours or grace period, the outpost
   * whenever it isn't live. Outpost checks are deliberately allowed in quiet hours and grace.
   */
  _handleCheckTrigger(userId, settings, player, message) {
    const wantWall = compileTriggers(settings.wall_trigger)(message);
    const wantRaid = compileTriggers(settings.raid_outpost_trigger)(message);
    if (!wantWall && !wantRaid) return;

    const state = this._stateFor(userId);
    const kinds = [];
    if (wantWall) {
      // Checks don't count during quiet hours — nobody is expected to be walking the walls then,
      // and letting them bank checks would inflate the leaderboard for hours nobody was watching.
      if (settings.grace_period) {
        this._notifyOnce(userId, player, 'Grace period — wall checks are off.');
      } else if (isQuietHours(Date.now(), settings.wall_quiet_start, settings.wall_quiet_end)) {
        this._notifyOnce(userId, player, 'Wall checks are paused during quiet hours.');
      } else {
        kinds.push('wall');
      }
    }
    if (wantRaid) {
      if (state.raidOutpostState === 'ACTIVE_CHECKING') kinds.push('raid');
      else this._notifyOnce(userId, player, 'No Raid Outpost check is running.');
    }
    if (!kinds.length) return;

    if (!this._requireAuthorized(userId, settings, player)) return;

    const now = Date.now();
    for (const kind of kinds) {
      const last = state.cooldowns.get(`${kind}:${player}`) || 0;
      if (now - last < CHECK_COOLDOWN_MS) {
        const wait = Math.ceil((CHECK_COOLDOWN_MS - (now - last)) / 1000);
        this._whisper(userId, player, `Already counted — wait ${wait}s before checking again.`);
        continue;
      }
      this._countCheck(userId, settings, player, { kind, announce: true });
    }
  }

  // A wall check moves only the wall clock and counter; a raid check only the outpost's.
  _countCheck(userId, settings, player, { kind = 'wall', announce }) {
    const state = this._stateFor(userId);
    const now = Date.now();
    const raid = kind === 'raid';

    const uuid = state.uuids.get(player) || '';
    (raid ? incRaidCheck : incWallCheck).run({ user_id: userId, player, uuid, last_check: now });
    this._rememberCase(userId, player); // a first check just created the stats row
    state.cooldowns.set(`${kind}:${player}`, now);
    state.totalChecks += 1;
    const prev = raid ? state.lastRaidCheckAt : state.lastCheckAt;
    const sinceLast = prev ? now - prev : 0;
    if (raid) {
      state.lastRaidCheckAt = now;
      state.lastRaidReminderAt = 0;
    } else {
      state.lastCheckAt = now;
      state.lastReminderAt = 0; // a real check restarts the reminder cycle
    }
    this._persist(userId, state);

    if (announce) {
      // allWallCheckers, not topWallCheckers — the latter stops at 10 rows, so anyone outside
      // the leaderboard would have been reported as having a single check.
      const mine = allWallCheckers.all(userId).find((r) => r.player === player) || {};
      const wallChecks = mine.checks || 0;
      const raidChecks = mine.raid_checks || 0;
      const shown = mine.display_name || state.displayNames.get(player) || player;
      const values = {
        player: shown,
        checks: raid ? raidChecks : wallChecks,
        total: state.totalChecks,
        minutes: Math.round(sinceLast / 60000),
      };
      const template = raid ? RAID_OUTPOST_CHECK_DEFAULT : (settings.wall_check_message || CHECK_DEFAULT);
      this._send(userId, fillPlaceholders(template, values), {
        channel: 'check',
        embed: {
          color: raid ? COLOR_RAID_LOG : COLOR_LOG,
          author: {
            name: `${shown} recorded a ${raid ? 'RAID OUTPOST CHECK' : 'WALL CHECK'}.`,
            icon_url: HEAD_URL(player),
          },
          fields: [
            { name: 'Clear at', value: `\`${formatClock(now)}\``, inline: false },
            { name: 'Time since last check', value: `\`${formatDuration(sinceLast)}\``, inline: true },
            { name: 'Raid Checks', value: `\`${raidChecks}\``, inline: true },
            { name: 'Wall Checks', value: `\`${wallChecks}\``, inline: true },
          ],
          footer: { text: this.resolveSession(userId)?.account?.username || 'wallbot' },
        },
      });
    }
    this.broadcast(userId);
  }

  // ---- raid ----

  _beginRaid(userId, settings, byPlayer) {
    const state = this._stateFor(userId);
    if (state.raidActive) {
      if (byPlayer) this._whisper(userId, byPlayer, 'Weewoo alert is already active.');
      return;
    }
    state.raidActive = true;
    state.raidStartedAt = Date.now();
    const delay = Math.max(3000, Number(settings.raid_delay_ms) || 15000);
    // Rebuilt on every repeat, not captured once — otherwise "time since alert" would freeze at
    // 0s and every repost would carry the opening timestamp.
    // Only the opening alert pings the role; the repeats every few seconds stay silent.
    this._sendRaidAlert(userId, { first: true });
    state.raidTimer = setInterval(() => this._sendRaidAlert(userId), delay);
    this._console(userId, `Weewoo alert started${byPlayer ? ` by ${byPlayer}` : ''}.`);
    this.broadcast(userId);
  }

  /** One raid alert: in-game text plus the Discord embed, with the elapsed time refreshed. */
  _sendRaidAlert(userId, { first = false } = {}) {
    const settings = getSettings.get(userId);
    const state = this._stateFor(userId);
    const startedAt = state.raidStartedAt || Date.now();
    const message = settings.raid_message || 'RAID ALERT - DEFEND THE BASE';

    this._send(userId, message, {
      channel: 'raid',
      ping: first && !!settings.ping_weewoo,
      embed: {
        color: COLOR_ALERT,
        author: { name: RAID_TITLE, icon_url: TNT_ICON },
        description: `**${settings.raid_discord_message || DISCORD_RAID_DEFAULT}**`,
        fields: [
          { name: 'Alert started', value: `\`${formatClock(startedAt)}\``, inline: false },
          { name: 'Time since alert', value: `\`${formatDuration(Date.now() - startedAt)}\``, inline: true },
        ],
        footer: { text: this.resolveSession(userId)?.account?.username || 'wallbot' },
      },
    });
  }

  _endRaid(userId, byPlayer) {
    const state = this._stateFor(userId);
    if (!state.raidActive) {
      if (byPlayer) this._whisper(userId, byPlayer, 'No weewoo alert is active.');
      return;
    }
    const lasted = state.raidStartedAt ? Date.now() - state.raidStartedAt : 0;
    state.raidActive = false;
    state.raidStartedAt = 0;
    clearInterval(state.raidTimer);
    state.raidTimer = null;
    this._send(userId, 'Weewoo alert cleared.', {
      channel: 'raid',
      embed: {
        color: COLOR_MUTED,
        author: { name: 'Weewoo alert cleared.', icon_url: TNT_ICON },
        fields: [
          { name: 'Alert lasted', value: `\`${formatDuration(lasted)}\``, inline: true },
        ],
        footer: { text: this.resolveSession(userId)?.account?.username || 'wallbot' },
      },
    });
    this._console(userId, `Weewoo alert stopped${byPlayer ? ` by ${byPlayer}` : ''}.`);
    this.broadcast(userId);
  }

  // ---- reminder loop ----

  _tick() {
    for (const [userId, state] of this.users) {
      this._taxTick(userId);
      if (Date.now() - state.lastBanPollAt >= BAN_POLL_MS && !state.banTimer) {
        state.lastBanPollAt = Date.now();
        this._syncBans(userId);
      }
      if (!state.wallActive || state.raidActive) continue;
      const settings = getSettings.get(userId);
      if (!settings?.wall_enabled) continue;

      const now = Date.now();
      const grace = !!settings.grace_period;
      const quiet = isQuietHours(now, settings.wall_quiet_start, settings.wall_quiet_end);
      // Grace period and quiet hours both pause walls. Coming out of either restarts the count —
      // nobody was expected to check, so carrying that silence forward would open with an
      // alarming number. `lastCheckAt` itself is left alone — it is the real record of when
      // someone last checked, and the panel reports it as such.
      const paused = grace || quiet;
      if (paused) {
        state.wasQuiet = true;
      } else if (state.wasQuiet) {
        state.wasQuiet = false;
        state.quietEndedAt = now;
        state.lastReminderAt = 0;
      }

      const interval = Math.max(30000, Number(settings.wall_interval_ms) || 600000);
      // Two separate clocks per kind, deliberately. `countFrom` is what "minutes unchecked"
      // measures — the last real check, or the end of the pause if that came later. The reminder
      // clocks control how often we repeat ourselves. Folding them together — as this used to —
      // made every reminder report the interval instead of the real elapsed time. Walls and the
      // outpost pace separately, so a fresh wall check never holds back an overdue raid reminder.
      const countFrom = Math.max(state.lastCheckAt, state.quietEndedAt || 0);
      const wallDue = !paused && now - countFrom >= interval
        && !(state.lastReminderAt && now - state.lastReminderAt < interval);
      const live = state.raidOutpostState === 'ACTIVE_CHECKING';
      const raidDue = live && now - state.lastRaidCheckAt >= interval
        && !(state.lastRaidReminderAt && now - state.lastRaidReminderAt < interval);
      if (!wallDue && !raidDue) continue;

      const last = lastWallChecker.get(userId);
      const lastRaid = lastRaidChecker.get(userId);
      const values = {
        minutes: Math.round((now - countFrom) / 60000),
        total: state.totalChecks,
        player: last?.display_name || last?.player || 'nobody',
        checks: last?.checks ?? 0,
        raidMinutes: Math.floor((now - state.lastRaidCheckAt) / 60000),
        raidPlayer: lastRaid?.display_name || lastRaid?.player || 'nobody',
        raidChecks: lastRaid?.raid_checks ?? 0,
        bot: this._botName(userId),
      };
      const wallBody = fillPlaceholders(settings.wall_discord_message || DISCORD_REMINDER_DEFAULT, values);
      const raidBody = fillPlaceholders(DISCORD_RAID_OUTPOST_DEFAULT, values);

      // The templates own the whole wording — nothing is appended behind the operator's back.
      let template;
      let embed;
      if (live && !paused) {
        // Outpost live in normal hours: whenever either side is overdue, send both reminders as two
        // chat messages. One combined line ran past the server's chat limit and got cut in half.
        template = `${settings.raid_outpost_reminder_message || RAID_OUTPOST_REMINDER_DEFAULT}\n`
          + (settings.wall_reminder_message || 'Wall check! Last checked {minutes}m ago.');
        embed = { title: 'Raid Outpost | Walls Alert!', description: `${raidBody}\n\n${wallBody}` };
      } else if (wallDue) {
        template = settings.wall_reminder_message || 'Wall check! Last checked {minutes}m ago.';
        embed = { title: 'Wall Check Alert!', description: wallBody };
      } else {
        // Paused with the outpost live: grace period or quiet hours. Walls stay silent, but the
        // raid prompt still goes to Minecraft and Discord.
        template = settings.raid_outpost_reminder_message || RAID_OUTPOST_REMINDER_DEFAULT;
        embed = {
          title: grace ? 'Raid Outpost Alert (Grace Period)!' : 'Raid Outpost Alert!',
          description: raidBody,
        };
      }
      this._send(userId, fillPlaceholders(template, values), {
        // Reminders, outpost ones included, share the wall channel — they are the same alert.
        channel: 'wall',
        embed: { color: COLOR_ALERT, ...embed },
      });
      if (wallDue) state.lastReminderAt = now;
      if (raidDue) state.lastRaidReminderAt = now;
      this.broadcast(userId);
    }
  }

  _botName(userId) {
    const session = this.resolveSession(userId);
    return session?.bot?.username || session?.account?.username || 'bot';
  }

  // ---- authorization ----

  _isAuthorized(userId, settings, player) {
    if (!settings.wall_require_verified) return true;
    const row = getWallPlayer.get(userId, player);
    return !!(row && row.verified);
  }

  // Tell a player something at most once a minute, so a refused trigger repeated in frustration
  // doesn't turn into the bot spamming them back.
  _notifyOnce(userId, player, text) {
    const state = this._stateFor(userId);
    const now = Date.now();
    if (now - (state.notices.get(player) || 0) < NOTICE_COOLDOWN_MS) return;
    state.notices.set(player, now);
    this._whisper(userId, player, text);
  }

  // Returns true when the player may proceed; otherwise replies (at most once a minute).
  _requireAuthorized(userId, settings, player) {
    if (this._isAuthorized(userId, settings, player)) return true;
    this._notifyOnce(userId, player, 'You are not verified — say "verify" in chat to get a code.');
    return false;
  }

  // ---- output ----

  /**
   * Broadcast message: Minecraft and/or Discord per the routing toggles, always the console.
   * A multi-line message is sent as one chat message per line, so a single reminder can combine
   * (say) a public call-out with a private status whisper. The outbound queue still spaces them,
   * so a two-line reminder goes out 1.5s apart rather than as a burst.
   */
  _send(userId, text, { channel = 'wall', embed = null, minecraft = true, ping = false } = {}) {
    const settings = getSettings.get(userId);
    const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;

    for (const line of lines) {
      this._console(userId, line);
      if (minecraft && settings?.wall_to_minecraft) this._enqueue(userId, line, line);
    }

    // Raid alerts, Raid Outpost notices and check logs can each go to their own channel. Without a
    // webhook of their own they fall back to the wall routing, so an unfilled field never silently
    // drops a message.
    const useRaid = channel === 'raid' && settings?.raid_to_discord && settings.raid_discord_webhook;
    const useCheck = channel === 'check' && settings?.check_to_discord && settings.check_discord_webhook;
    // Raid Outpost ownership news needs no toggle: filling in the URL is the opt-in.
    const useOutpost = channel === 'raid_outpost' && settings?.raid_outpost_discord_webhook;
    const webhook = useRaid ? settings.raid_discord_webhook
      : useCheck ? settings.check_discord_webhook
        : useOutpost ? settings.raid_outpost_discord_webhook
          : settings?.wall_discord_webhook;
    const enabled = useRaid || useCheck || useOutpost || settings?.wall_to_discord;
    // Discord gets it as one post — line breaks read fine there and it avoids N pings.
    if (enabled && webhook) {
      this._postDiscord(userId, webhook, lines.join('\n'), embed, ping ? parseRoleId(settings.discord_ping_role) : null);
    }
  }

  /**
   * Post the wall check board (walls / raid / total per player) to Discord, on demand from the
   * panel. Discord-only, like postLeaderboard. The button is the opt-in, so no toggle gates it:
   * its own webhook when filled in, else the check log one when that's on, else the wall one.
   */
  postCheckBoard(userId, sort) {
    const settings = getSettings.get(userId);
    const useCheck = settings?.check_to_discord && settings.check_discord_webhook;
    const webhook = settings?.check_board_discord_webhook
      || (useCheck ? settings.check_discord_webhook : settings?.wall_discord_webhook);
    if (!webhook) {
      this._error(userId, 'Check board: set a Discord webhook for it (Settings › Other channels) first.');
      return;
    }
    const by = BOARD_SORTS[sort] ? sort : (BOARD_SORTS[settings.wall_board_sort] ? settings.wall_board_sort : 'total');
    const state = this._stateFor(userId);
    const rows = allWallCheckers.all(userId)
      .map((r) => ({ ...r, player: r.display_name || state.displayNames.get(r.player) || r.player }));
    this._postDiscord(userId, webhook, '', {
      color: COLOR_LOG,
      title: 'Wall Checks',
      description: formatCheckBoard(rows, by),
      footer: { text: `sorted by ${BOARD_SORTS[by].label} · ${state.totalChecks} checks all-time` },
    });
    this._console(userId, `Posted the check board to Discord (by ${BOARD_SORTS[by].label}).`);
  }

  /**
   * Post a parsed factions board to Discord. Discord-only by design: the whole point of the
   * hourly refresh is that nobody has to read the board in chat, so echoing ten lines back into
   * Minecraft would be the opposite of useful (and a fast route to a spam mute).
   */
  postLeaderboard(userId, entries) {
    if (!entries?.length) return;
    const settings = getSettings.get(userId);
    const useBoard = settings?.leaderboard_to_discord && settings.leaderboard_discord_webhook;
    const webhook = useBoard ? settings.leaderboard_discord_webhook : settings?.wall_discord_webhook;
    const enabled = useBoard || settings?.wall_to_discord;
    if (!enabled || !webhook) return;

    const rows = entries.map((e) => {
      const gain = e.gain === null || e.gain === undefined
        ? ''
        : ` (${e.gain >= 0 ? '+' : ''}${e.gain.toLocaleString('en-US')})`;
      return `\`${String(e.rank).padStart(2, ' ')}.\` **${e.name}** — ${e.points.toLocaleString('en-US')}${gain}`;
    });

    this._postDiscord(userId, webhook, '', {
      color: COLOR_BOARD,
      title: 'Top Factions',
      description: rows.join('\n'),
      footer: { text: this.resolveSession(userId)?.account?.username || 'wallbot' },
    });
  }

  /** Private reply to one player. Never leaves Minecraft — codes and refusals aren't for Discord. */
  _whisper(userId, player, text) {
    const settings = getSettings.get(userId);
    if (!settings?.wall_to_minecraft) {
      this._console(userId, `(to ${player}) ${text}`);
      return;
    }
    // Servers differ on the whisper command (/msg, /w, /tell, /pm). Verification codes are
    // delivered this way, so getting it wrong silently breaks verification.
    const cmd = String(settings.wall_msg_command || '/msg').trim();
    const name = this._stateFor(userId).displayNames.get(normalizePlayer(player)) || player;
    this._enqueue(userId, `${cmd} ${name} ${text}`, text);
  }

  // Space outbound chat out. Bursting is what trips server anti-spam and gets the account muted.
  _enqueue(userId, line, body) {
    const state = this._stateFor(userId);
    state.queue.push(line);
    if (body) {
      state.recentSent.push(body);
      while (state.recentSent.length > RECENT_SENT_MAX) state.recentSent.shift();
    }
    this._drain(userId);
  }

  _drain(userId) {
    const state = this._stateFor(userId);
    if (state.sendTimer || !state.queue.length) return;
    const wait = Math.max(0, SEND_GAP_MS - (Date.now() - state.lastSentAt));
    state.sendTimer = setTimeout(() => {
      state.sendTimer = null;
      const line = state.queue.shift();
      if (line) {
        const session = this.resolveSession(userId);
        if (session) {
          session.sendChat(line);
          state.lastSentAt = Date.now();
        } else {
          this._error(userId, 'Wall bot: no online account to send through.');
          state.queue.length = 0;
          return;
        }
      }
      this._drain(userId);
    }, wait);
  }

  async _postDiscord(userId, webhook, text, embed = null, pingRole = null, pingUsers = []) {
    // An embed gives the message a coloured bar, a bold title and a rendered timestamp. Without
    // one we fall back to a plain content post, so nothing depends on the embed being supplied.
    let body;
    if (embed) {
      // The caller's object is the embed. Anything Discord accepts (author, fields, footer…)
      // passes straight through; only the timestamp is always ours.
      const built = { timestamp: new Date().toISOString(), ...embed };
      // Fall back to the chat text as the body, but not when the embed carries its own fields —
      // those already say everything, and a duplicate line above them just looks like a bug.
      if (built.description === undefined && !built.fields) built.description = text;
      body = { embeds: [built] };
    } else {
      body = { content: text };
    }
    // Embeds never ping, so a role mention has to ride in `content`. allowed_mentions limits the
    // post to exactly that role — nothing else in the message can ping anyone.
    if (pingRole) {
      body.content = `<@&${pingRole}>${body.content ? ` ${body.content}` : ''}`;
      body.allowed_mentions = { roles: [pingRole] };
    } else if (pingUsers.length) {
      // ponytail: Discord caps allowed_mentions.users at 100; chunk the post if a tax list outgrows it.
      const ids = pingUsers.slice(0, 100);
      body.content = `${ids.map((id) => `<@${id}>`).join(' ')}${body.content ? ` ${body.content}` : ''}`;
      body.allowed_mentions = { users: ids };
    }
    try {
      const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      // Never let a dead webhook break the Minecraft path.
      this._error(userId, `Discord webhook failed: ${e.message}`);
    }
  }

  _console(userId, text) {
    const session = this.resolveSession(userId);
    this.emitToUser(userId, {
      type: 'consoleLine',
      accountId: session?.account?.id,
      username: session?.account?.username || 'wallbot',
      text: `[wall] ${text}`,
    });
  }

  _error(userId, message) {
    this.emitToUser(userId, { type: 'error', message });
  }

  // ---- state ----

  _persist(userId, state) {
    upsertWallState.run({
      user_id: userId,
      total_checks: state.totalChecks,
      last_check_at: state.lastCheckAt,
      raid_outpost_state: state.raidOutpostState,
      raid_outpost_holder: state.raidOutpostHolder,
      raid_outpost_claimed_at: state.raidOutpostClaimedAt,
      last_raid_check_at: state.lastRaidCheckAt,
    });
  }

  /** Re-read persisted counters, e.g. after a reset wiped them out from under us. */
  reload(userId) {
    const state = this._stateFor(userId);
    const row = getWallState.get(userId);
    state.totalChecks = row?.total_checks || 0;
    state.lastCheckAt = row?.last_check_at || 0;
    state.lastRaidCheckAt = row?.last_raid_check_at || 0;
    state.cooldowns.clear();
    this.broadcast(userId);
  }

  snapshot(userId) {
    const state = this._stateFor(userId);
    return {
      type: 'wallState',
      active: state.wallActive,
      raidActive: state.raidActive,
      lastCheckAt: state.lastCheckAt,
      totalChecks: state.totalChecks,
      raidOutpostState: state.raidOutpostState,
      lastRaidCheckAt: state.lastRaidCheckAt,
      top: topWallCheckers.all(userId),
      roster: listWallPlayers.all(userId),
      tax: (({ tax_amount: amount, tax_started_at: startedAt, tax_due_at: dueAt, tax_started_by: startedBy } = {}) => (
        dueAt ? { amount, startedAt, dueAt, startedBy } : null))(this._taxRow(userId) || {}),
      accountOnline: !!this.resolveSession(userId),
    };
  }

  broadcast(userId) {
    this.emitToUser(userId, this.snapshot(userId));
  }
}
