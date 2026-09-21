export interface Game {
  name: string;
  game_biz: string;
  act_id: string;
  signgame?: string;
  info_url?: string;
  sign_url?: string;
}

export const BASE = "https://api-takumi.mihoyo.com";
export const ROLE_URL = `${BASE}/binding/api/getUserGameRolesByCookie`;
export const INFO_URL = `${BASE}/event/luna/info?lang=zh-cn`;
export const SIGN_URL = `${BASE}/event/luna/sign`;
export const ZZZ_INFO_URL = "https://act-nap-api.mihoyo.com/event/luna/zzz/info?lang=zh-cn";
export const ZZZ_SIGN_URL = "https://act-nap-api.mihoyo.com/event/luna/zzz/sign";

export const GAMES: Record<string, Game> = {
  genshin: {
    name: "原神",
    game_biz: "hk4e_cn",
    act_id: "e202311201442471",
    signgame: "hk4e",
  },
  starrail: {
    name: "崩坏：星穹铁道",
    game_biz: "hkrpg_cn",
    act_id: "e202304121516551",
  },
  zzz: {
    name: "绝区零",
    game_biz: "nap_cn",
    act_id: "e202406242138391",
    signgame: "zzz",
    info_url: ZZZ_INFO_URL,
    sign_url: ZZZ_SIGN_URL,
  },
  honkai3rd: {
    name: "崩坏3",
    game_biz: "bh3_cn",
    act_id: "e202306201626331",
  },
  tears: {
    name: "未定事件簿",
    game_biz: "nxx_cn",
    act_id: "e202202251749321",
  },
  honkai2: {
    name: "崩坏学园2",
    game_biz: "bh2_cn",
    act_id: "e202203291431091",
  },
};

export const DEFAULT_GAMES = ["genshin", "starrail", "zzz"];

export function gameNames(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, game] of Object.entries(GAMES)) out[key] = game.name;
  return out;
}
