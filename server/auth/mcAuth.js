import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_ROOT = process.env.TOKENS_DIR || path.join(__dirname, '..', '..', 'data', 'tokens');

// prismarine-auth pulls in a large dependency tree (@azure/msal-node, jose, …) that is
// slow to load on a cold/slow filesystem. Import it lazily so the web server can boot
// without paying that cost — it's only needed when a Microsoft sign-in actually runs.
// The promise is cached, so it loads at most once per process.
let prismarineAuthPromise = null;
function loadPrismarineAuth() {
  if (!prismarineAuthPromise) prismarineAuthPromise = import('prismarine-auth');
  return prismarineAuthPromise;
}

// Per-user prismarine-auth cache folder. mineflayer reuses the same folder via
// `profilesFolder`, so a token warmed here means a silent (no-prompt) connect later.
// (Only fs/path — deliberately free of the prismarine-auth import so BotSession can
// call it without dragging that heavy module into the connect path twice.)
export function profilesFolderFor(userId) {
  const dir = path.join(TOKENS_ROOT, String(userId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Runs the Microsoft device-code flow to authenticate an account and warm its token
 * cache. `onCode` receives the device-code prompt ({ user_code, verification_uri, ... })
 * so the browser can show it. Resolves with the resolved Minecraft profile name.
 *
 * @param {string} userId         site user
 * @param {string} tokenRef       stable cache-key identifier for this MC account
 * @param {(code:object)=>void} onCode
 */
export async function authenticateMicrosoft(userId, tokenRef, onCode) {
  // prismarine-auth is CommonJS: when pulled in via dynamic import(), Node's CJS interop
  // exposes `Authflow` as a named export but NOT `Titles` (it lands only on `.default`).
  // Destructure from the module.exports object so both are always defined.
  const pa = await loadPrismarineAuth();
  const { Authflow, Titles } = pa.default ?? pa;
  // Must match mineflayer/minecraft-protocol's own defaults exactly, so the token
  // cache warmed here is reused (same clientId + cache file) when the bot connects.
  // minecraft-protocol defaults to the Nintendo Switch title on the `live` device-code
  // flow; the older `msal` flow expects an Azure AD client ID (not this Live title) and
  // fails token exchange with `invalid_grant`.
  const flowOptions = { flow: 'live', authTitle: Titles.MinecraftNintendoSwitch, deviceType: 'Nintendo' };
  const flow = new Authflow(tokenRef, profilesFolderFor(userId), flowOptions, (code) => {
    onCode({
      user_code: code.user_code ?? code.userCode,
      verification_uri: code.verification_uri ?? code.verificationUri,
      expires_in: code.expires_in ?? code.expiresIn,
      message: code.message,
    });
  });
  const result = await flow.getMinecraftJavaToken({ fetchProfile: true });
  const username = result?.profile?.name;
  if (!username) throw new Error('Microsoft auth succeeded but no profile name was returned');
  return { username };
}
