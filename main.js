// =====================================================================
// Kit 指令套装行为包 v1.1.0 (Minecraft Bedrock, @minecraft/server 2.x stable)
//   /k:kits [n]      打开第 n 套的"大箱子配置箱"（54格，分区：装备/快捷栏/背包）
//   /k:kit [n]       一键穿戴第 n 套（不带参数=第1套）
//   /k:kitlist       套装管理菜单
//   /k:kitsdel <n>   清空指定套装
//   /k:kitsdone      手动保存并收回配置箱（兜底）
// 存储：末地隐藏仓库区，每 kit 一对合并的大箱子（tickingarea 常加载 + 破坏保护）。
// v1.1.0：大箱子54格分区布局；旧单箱kit自动迁移；切换套装时明示并加固保存。
// =====================================================================

import * as mc from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";

const world = mc.world;
const system = mc.system;

// ------------------------- 可调配置 -------------------------
const CFG = {
  NS: "k",
  MAX_KITS: 9,
  DEFAULT_EQUIP_KIT: 1,
  VAULT_DIM: "minecraft:the_end",
  VAULT_BASE: { x: 1000, y: 100, z: 1000 },
  COLS: 6,               // 仓库每行玩家数
  CELLX: 20,             // 每玩家横向间距（9 对箱子，间隔 1 格防误合并）
  CELLZ: 6,
  PROP: "kitc"
};
const P = (s) => `${CFG.PROP}:${s}`;

let CHEST_PERM = null;
function chestPerm() {
  if (!CHEST_PERM) { try { CHEST_PERM = mc.BlockPermutation.resolve("minecraft:chest"); } catch (e) { return null; } }
  return CHEST_PERM;
}
const AIR_PERM = (() => { try { return mc.BlockPermutation.resolve("minecraft:air"); } catch (e) { return null; } })();

const guiState = new Map(); // playerName -> st

// ------------------------- 小工具 -------------------------
function copyRange(src, dst, srcFrom, dstFrom, n) {
  for (let k = 0; k < n; k++) {
    let it; try { it = src.getItem(srcFrom + k); } catch (e) { continue; }
    if (!it || isGuide(it)) continue;
    try { dst.setItem(dstFrom + k, it.clone()); } catch (e) { try { dst.setItem(dstFrom + k, it); } catch (e2) {} }
  }
}
function clearRange(c, from, to) { for (let i = from; i < Math.min(to, contSize(c)); i++) { try { c.setItem(i, undefined); } catch (e) {} } }
const fl = Math.floor;
const isAirLike = (id) => id === "minecraft:air" || id === "minecraft:void_air" || id.endsWith("water") || id.endsWith("lava");
const vkey = (dimId, v) => `${dimId}|${fl(v.x)}|${fl(v.y)}|${fl(v.z)}`;
function say(player, text) { try { player.sendMessage(text); } catch (e) { try { world.sendMessage(text); } catch (e2) {} } }
function getCont(host) { try { const c = host.getComponent("minecraft:inventory"); return c && c.container; } catch (e) { return undefined; } }
function contSize(c) { try { return c.size; } catch (e) { return 27; } }
function clearCont(c) { const n = contSize(c); for (let i = 0; i < n; i++) { try { c.setItem(i, undefined); } catch (e) {} } }
function isGuide(it) { try { return it.typeId === "minecraft:paper" && it.nameTag && String(it.nameTag).startsWith(GUIDE_MARK); } catch (e) { return false; } }
const GUIDE_MARK = "§b▲";
function guideItem(label) {
  try { const it = new mc.ItemStack("minecraft:paper", 1); it.nameTag = GUIDE_MARK + label; return it; } catch (e) { return undefined; }
}
function stripGuides(c) { const n = contSize(c); for (let i = 0; i < n; i++) { try { const it = c.getItem(i); if (it && isGuide(it)) c.setItem(i, undefined); } catch (e) {} } }
function copyCont(src, dst, size) {
  const n = Math.min(contSize(src), size || contSize(dst));
  clearCont(dst);
  for (let i = 0; i < n; i++) {
    let it; try { it = src.getItem(i); } catch (e) { continue; }
    if (!it || isGuide(it)) continue;
    try { dst.setItem(i, it.clone()); } catch (e) { try { dst.setItem(i, it); } catch (e2) {} }
  }
}
function contItems(c) {
  const out = []; const n = contSize(c);
  for (let i = 0; i < n; i++) { try { const it = c.getItem(i); if (it && !isGuide(it)) out.push({ i, it }); } catch (e) {} }
  return out;
}

// 分区锚点：穿戴区=第1行前5格(0-4)，快捷栏区=第2行(9-17)，背包区=第3行起(18+)；27格单箱用同一套锚点，只是背包区容量小
function layout(size) {
  return { armor: [0, 1, 2, 3], off: 4, hb: [9, 17], invFrom: 18,
    labels: size >= 54
      ? { 0: "头盔→", 1: "胸甲→", 2: "护腿→", 3: "靴子→", 4: "副手→", 9: "→快捷栏1~9", 18: "→背包区(第3行起全部)" }
      : { 0: "头盔→", 1: "胸甲→", 2: "护腿→", 3: "靴子→", 4: "副手→", 9: "→快捷栏1~9", 18: "→背包区" } };
}

// ------------------------- 仓库(大箱子对) -------------------------
function getPlayerIdx(player) {
  let idx; try { idx = player.getDynamicProperty(P("idx")); } catch (e) {}
  if (typeof idx === "number") return idx;
  let next = 0;
  try { next = world.getDynamicProperty(P("nextidx")) || 0; world.setDynamicProperty(P("nextidx"), next + 1); } catch (e) {}
  player.setDynamicProperty(P("idx"), next);
  return next;
}
function vaultPair(idx, kit) { // v1.1 大箱子对（沿z成对合并为54格；相邻kit间隔1格，避免像旧版那样误合并）
  const bx = CFG.VAULT_BASE.x + (idx % CFG.COLS) * CFG.CELLX;
  const bz = CFG.VAULT_BASE.z + Math.floor(idx / CFG.COLS) * CFG.CELLZ;
  const x = bx + (kit - 1) * 2, y = CFG.VAULT_BASE.y + 8;
  return [{ x, y, z: bz }, { x, y, z: bz + 1 }];
}
function vaultPairLegacy(idx, kit) { // v1.0.x 的 3x3 单箱位，用于旧数据迁移
  const bx = CFG.VAULT_BASE.x + (idx % 10) * 8;
  const bz = CFG.VAULT_BASE.z + Math.floor(idx / 10) * 8;
  return { x: bx + ((kit - 1) % 3), y: CFG.VAULT_BASE.y, z: bz + Math.floor((kit - 1) / 3) };
}
function ensureVaultArea(idx) {
  const bx = CFG.VAULT_BASE.x + (idx % CFG.COLS) * CFG.CELLX;
  const bz = CFG.VAULT_BASE.z + Math.floor(idx / CFG.COLS) * CFG.CELLZ;
  const dim = world.getDimension(CFG.VAULT_DIM);
  const name = `kitv_${idx}`;
  const cmds = [
    `tickingarea add ${bx - 1} ${CFG.VAULT_BASE.y - 2} ${bz - 1} ${bx + (CFG.MAX_KITS - 1) * 2 + 1} ${CFG.VAULT_BASE.y + 10} ${bz + 2} ${name}`,
    `tickingarea add circle ${bx + 8} ${CFG.VAULT_BASE.y + 4} ${bz} 5 ${name}`
  ];
  for (const c of cmds) { try { dim.runCommand(c); return true; } catch (e) {} }
  return false;
}
function getBlockSafe(dim, p) { try { return dim.getBlock(p); } catch (e) { return undefined; } }
function pairContainer(blocks) { // 优先取合并后的 54 格容器
  let bestC, bestN = 0;
  for (const b of blocks) { const c = b && getCont(b); const n = c ? contSize(c) : 0; if (n > bestN) { bestN = n; bestC = c; } }
  return bestC;
}
function pairSize(dim, a, b) {
  let best = 0;
  for (const p of [a, b]) { if (!p) continue; const blk = getBlockSafe(dim, p); const c = blk && getCont(blk); if (c) best = Math.max(best, contSize(c)); }
  return best;
}
function sbChest(dim, p) { try { dim.runCommand(`setblock ${p.x} ${p.y} ${p.z} minecraft:chest`); return true; } catch (e) { return false; } }
function sbAir(dim, p) { try { dim.runCommand(`setblock ${p.x} ${p.y} ${p.z} minecraft:air`); } catch (e) {} }
// 强制修复"相邻但未合并"的两只箱子：用 setblock 先清后放触发引擎连接判定
function ensurePairMerged(dim, a, b, perm) {
  try { const ba = dim.getBlock(a); if (ba && ba.typeId !== "minecraft:chest" && perm) ba.setPermutation(perm); } catch (e) {}
  try { const bb = dim.getBlock(b); if (bb && bb.typeId !== "minecraft:chest" && perm) bb.setPermutation(perm); } catch (e) {}
  if (pairSize(dim, a, b) >= 54) return true;
  sbAir(dim, b); sbChest(dim, b);
  if (pairSize(dim, a, b) >= 54) return true;
  sbAir(dim, a); sbChest(dim, a); sbAir(dim, b); sbChest(dim, b);
  return pairSize(dim, a, b) >= 54;
}
// 源 -> 目标 同位镜像，仅清写公共区间，保住目标箱多出来的尾部；源尾部有货则拒写
function mirrorCopy(src, dst) {
  const sn = contSize(src), dn = contSize(dst), n = Math.min(sn, dn);
  if (sn > dn) {
    for (let i = dn; i < sn; i++) {
      let it; try { it = src.getItem(i); } catch (e) { it = undefined; }
      if (it && !isGuide(it)) return { ok: false, tail: i };
    }
  }
  clearRange(dst, 0, n);
  copyRange(src, dst, 0, 0, n);
  return { ok: true };
}
// ---- 半箱视图：基岩版"大箱子"= 两个27格半箱（UI上3行=先放的半箱）。API里单看任何一格都是27，
// ---- 因此统一用 vcont 把两半拼成逻辑54格视图，所有读写只面对视图，与引擎是否报54无关。
function vcont(parts0) {
  const parts = parts0.filter((x) => !!x);
  const offs = []; let acc = 0;
  for (const c of parts) { offs.push(acc); acc += contSize(c); }
  const locate = (i) => {
    for (let k = parts.length - 1; k >= 0; k--) {
      const s = i - offs[k];
      if (s >= 0 && s < contSize(parts[k])) return [parts[k], s];
    }
    return [null, 0];
  };
  return {
    size: acc,
    getItem(i) { const [c, s] = locate(i); if (!c) return undefined; try { return c.getItem(s); } catch (e) { return undefined; } },
    setItem(i, it) { const [c, s] = locate(i); if (!c) return; try { c.setItem(s, it); } catch (e) {} },
    _raw: parts
  };
}
function guiView(st) { // 玩家身边配置箱的 54 格视图（两半箱）或 27 格（单箱）
  const ba = getBlockSafe(st.dim, st.a);
  const bb = st.b ? getBlockSafe(st.dim, st.b) : null;
  const ca = ba && ba.typeId === "minecraft:chest" ? getCont(ba) : null;
  const cb = bb && bb.typeId === "minecraft:chest" ? getCont(bb) : null;
  if (ca && contSize(ca) >= 54) return vcont([ca]);
  if (cb && contSize(cb) >= 54) return vcont([cb]);
  if (st.kind === "double" && ca && cb) return vcont([ca, cb]);
  return vcont([ca]);
}
function getVaultChest(player, kit) { // 返回 {blocks, cont}
  const idx = getPlayerIdx(player);
  ensureVaultArea(idx);
  const dim = world.getDimension(CFG.VAULT_DIM);
  const p = chestPerm();
  if (!p) return undefined;
  const pair = vaultPair(idx, kit);
  const a = getBlockSafe(dim, pair[0]), b = getBlockSafe(dim, pair[1]);
  if (!a || !b) return undefined;
  for (const blk of [a, b]) { if (blk.typeId !== "minecraft:chest") { try { blk.setPermutation(p); } catch (e) {} } }
  const ca = getCont(getBlockSafe(dim, pair[0]));
  const cb = getCont(getBlockSafe(dim, pair[1]));
  const cont = (ca && contSize(ca) >= 54) ? vcont([ca]) : (cb && contSize(cb) >= 54) ? vcont([cb]) : vcont([ca, cb]);
  if (!cont || cont.size === 0) return undefined;
  // 旧版单箱数据迁移
  try {
    const lg = getBlockSafe(dim, vaultPairLegacy(idx, kit));
    if (lg && lg.typeId === "minecraft:chest") {
      const lc = getCont(lg);
      if (lc) {
        const old = contItems(lc);
        if (old.length > 0 && cont) for (const { i, it } of old) { try { cont.setItem(i, it.clone()); } catch (e) {} }
        clearCont(lc);
        if (AIR_PERM) try { lg.setPermutation(AIR_PERM); } catch (e) {}
      } else if (AIR_PERM) { try { lg.setPermutation(AIR_PERM); } catch (e) {} }
    }
  } catch (e) {}
  return { blocks: [getBlockSafe(dim, pair[0]), getBlockSafe(dim, pair[1])], cont };
}
function setHas(player, kit, flag) { try { player.setDynamicProperty(P(`has:${kit}`), !!flag); } catch (e) {} }
function isHas(player, kit) { try { return !!player.getDynamicProperty(P(`has:${kit}`)); } catch (e) { return false; } }

// ------------------------- 配置箱（玩家身边的大箱子） -------------------------
function findGuiSpots(player) { // 返回候选[{a,b?单箱为null,origA,origB,dim,...}]
  const dim = player.dimension;
  const loc = player.location;
  let vx = 0, vz = 1;
  try {
    const v = player.getViewDirection();
    if (v) { if (Math.abs(v.x) >= Math.abs(v.z)) { vx = v.x > 0 ? 1 : -1; vz = 0; } else { vz = v.z > 0 ? 1 : -1; vx = 0; } }
  } catch (e) {}
  const fx = fl(loc.x), fy = fl(loc.y), fz = fl(loc.z);
  const ox = 0, oz = 1; // 配对固定沿南北方向（z 轴）排布，实测该朝向合并大箱子最稳定
  const cands = [];
  for (let k = 2; k <= 4; k++) cands.push({ x: fx + vx * k, y: fy + 1, z: fz + vz * k });
  [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(([dx, dz]) => {
    for (let dy = 1; dy <= 2; dy++) cands.push({ x: fx + dx, y: fy + dy, z: fz + dz });
  });
  const isChestAt = (p) => { const b = getBlockSafe(dim, p); return !!b && b.typeId === "minecraft:chest"; };
  // 检查 p 的四邻是否有"配对之外"的箱子，防止我们的箱子与旁边任何箱子合并串箱
  const adjOtherChest = (p, pa, pb) => {
    const nb = [{ x: p.x + 1, y: p.y, z: p.z }, { x: p.x - 1, y: p.y, z: p.z }, { x: p.x, y: p.y, z: p.z + 1 }, { x: p.x, y: p.y, z: p.z - 1 }];
    const inPair = (q) => pa && q.x === pa.x && q.y === pa.y && q.z === pa.z || pb && q.x === pb.x && q.y === pb.y && q.z === pb.z;
    return nb.some((q) => isChestAt(q) && !inPair(q));
  };
  const usable = (p) => {
    const b = getBlockSafe(dim, p);
    if (!b) return null;
    if (b.typeId === "minecraft:bedrock" || b.typeId === "minecraft:chest" || b.typeId === "minecraft:barrier") return null;
    if (isChestAt({ x: p.x + 1, y: p.y, z: p.z }) || isChestAt({ x: p.x - 1, y: p.y, z: p.z }) ||
        isChestAt({ x: p.x, y: p.y, z: p.z + 1 }) || isChestAt({ x: p.x, y: p.y, z: p.z - 1 })) return null; // 紧贴已有箱子的一律不用
    return b;
  };
  const spots = [];
  for (const p of cands) {
    const ba = usable(p);
    if (!ba) continue;
    for (const s of [1, -1]) {
      const q = { x: p.x + ox * s, y: p.y, z: p.z + oz * s };
      const bb = usable(q);
      if (bb) { spots.push({ kind: "double", dim, dimId: dim.id, a: p, b: q, origA: ba.permutation, origB: bb.permutation, origAType: ba.typeId, origBType: bb.typeId, air: isAirLike(ba.typeId) && isAirLike(bb.typeId) }); }
    }
    spots.push({ kind: "single", dim, dimId: dim.id, a: p, b: null, origA: ba.permutation, origB: null, origAType: ba.typeId, origBType: null, air: isAirLike(ba.typeId) });
  }
  spots.sort((x, y) => (y.kind === "double" ? 1 : 0) - (x.kind === "double" ? 1 : 0) || (y.air ? 1 : 0) - (x.air ? 1 : 0));
  return spots.slice(0, 10);
}
function restoreSpot(st) {
  const dim = st.dim || world.getDimension(st.dimId);
  try { const b = getBlockSafe(dim, st.a); if (b) { if (st.origA) b.setPermutation(st.origA); else if (AIR_PERM) b.setPermutation(AIR_PERM); } } catch (e) {}
  try { if (st.kind === "double" && st.b) { const b2 = getBlockSafe(dim, st.b); if (b2) { if (st.origB) b2.setPermutation(st.origB); else if (AIR_PERM) b2.setPermutation(AIR_PERM); } } } catch (e) {}
}
function persistGui(player, st) {
  try {
    player.setDynamicProperty(P("gui"), JSON.stringify({ kind: st.kind, a: st.a, b: st.b, kit: st.kit, dim: st.dimId, origA: st.origAType, origB: st.origBType }));
  } catch (e) {}
}
function dropGuiProp(player) { try { player.setDynamicProperty(P("gui"), undefined); } catch (e) {} }

function putGuides(cont) {
  const L = layout(contSize(cont));
  for (const [s, label] of Object.entries(L.labels)) {
    const i = Number(s);
    try { if (!cont.getItem(i)) { const g = guideItem(label); if (g) cont.setItem(i, g); } } catch (e) {}
  }
}
function openKitEditor(player, kit) {
  if (kit < 1 || kit > CFG.MAX_KITS) { say(player, `§c套装编号需在 1~${CFG.MAX_KITS} 之间。`); return; }
  if (guiState.has(player.name)) finishGui(player, false); // 切换套装：先保存上一箱
  const vault = getVaultChest(player, kit);
  if (!vault || !vault.cont) { say(player, "§c仓库区块未能加载：请确认【世界设置-作弊】已开启，稍后重试。"); return; }
  const p = chestPerm();
  if (!p) { say(player, "§c方块系统异常：无法生成箱子。"); return; }
  const spots = findGuiSpots(player);
  if (!spots.length) { say(player, "§c身边找不到放箱子的位置，请站到平整开阔处再试。"); return; }
  let st = null, lastErr = "";
  for (const s of spots) {
    try {
      const ba = s.dim.getBlock(s.a); if (!ba) continue;
      ba.setPermutation(p);
      if (s.kind === "double" && s.b) { const bb = s.dim.getBlock(s.b); if (!bb) continue; bb.setPermutation(p); }
      st = Object.assign({}, s, { kit, ts: Date.now() });
      break;
    } catch (e) { lastErr = (e && e.message) ? e.message : String(e); }
  }
  if (!st && spots.length) { // 兜底：指令放置（失败通常是被其他保护拦截）
    const s = spots[0];
    try {
      s.dim.runCommand(`setblock ${s.a.x} ${s.a.y} ${s.a.z} minecraft:chest`);
      if (s.kind === "double" && s.b) s.dim.runCommand(`setblock ${s.b.x} ${s.b.y} ${s.b.z} minecraft:chest`);
      st = Object.assign({}, s, { kit, ts: Date.now() });
    } catch (e) { lastErr = (e && e.message) ? e.message : String(e); }
  }
  if (!st) { say(player, "§c配置箱放置失败：" + (lastErr || "未知原因")); return; }
  guiState.set(player.name, st);
  persistGui(player, st);
  try { player.setDynamicProperty(P("last"), kit); } catch (e) {}
  // 方块实体需要 1~2 tick 才挂上容器，延迟校验并填充
  setTimeoutSafe(() => {
    if (guiState.get(player.name) !== st) return;
    if (st.kind === "double") {
      let bb1 = getBlockSafe(st.dim, st.b);
      if (!bb1 || bb1.typeId !== "minecraft:chest") {
        ensurePairMerged(st.dim, st.a, st.b, chestPerm()); // 半箱缺失时用 setblock 补放
        bb1 = getBlockSafe(st.dim, st.b);
      }
      if (!bb1 || bb1.typeId !== "minecraft:chest") {
        st.kind = "single"; st.b = null; st.origB = null;
        say(player, "§e附近放不下第二半只箱子，本次按 27 格单箱编辑（下次请到更开阔处重开）。");
      }
    }
    const gcont = guiView(st);
    if (!gcont || gcont.size === 0) { finishGui(player, false); say(player, "§c读取箱子容器失败，请靠近位置重试 /k:kits " + kit); return; }
    const r0 = mirrorCopy(vault.cont, gcont); // 仓库 -> 配置箱（同位镜像，不伤仓库尾部）
    if (!r0.ok) {
      guiState.delete(player.name); dropGuiProp(player);
      try { clearCont(gcont); } catch (e) {}
      restoreSpot(st);
      say(player, `§c配置箱(${contSize(gcont)}格)装不下仓库内容(第${r0.tail + 1}格溢出)，数据未动。请清理出 54 格大箱空间后重试 /k:kits ${kit}。`);
      return;
    }
    putGuides(gcont);                           // 空位放置分区指引标签（保存时自动剔除）
    try { st.dim.runCommand(`data modify block ${st.a.x} ${st.a.y} ${st.a.z} CustomName set value "套装${kit}·配置箱(54格分区)"`); } catch (e) {}
    const cnt = contItems(gcont).length;
    try { player.onScreenDisplay.setActionBar(`§e【套装 ${kit}】已载入：${cnt} 格内容（第1行=穿戴区，第2行=快捷栏区，其余=背包区）`); } catch (e) { say(player, `§e【套装 ${kit}】已载入：${cnt} 格内容`); }
  }, 6);
  try { player.playSound("random.chestopen", { volume: 0.8 }); } catch (e) {}
  say(player, `§a正在放置【套装 ${kit}】配置箱（${st.kind === "double" ? "大箱子 54 格" : "单箱 27 格"}）§r\n§7分区：第1行前5格=头盔/胸甲/护腿/靴子/副手；第2行=快捷栏1~9；其余=背包。\n§7蓝色▲纸片只是位置标签，可直接拿走，保存时自动剔除。§o关箱即自动保存。§r`);
}

function finishGui(player, announce) {
  const st = guiState.get(player.name);
  if (!st) return false;
  guiState.delete(player.name);
  dropGuiProp(player);
  const savedKit = st.kit;
  let ok = true, empty = true;
  const vault = getVaultChest(player, savedKit);
  const vcontObj = vault && vault.cont;
  const gcont = guiView(st);
  const gN = gcont ? gcont.size : 0;
  const vN = vcontObj ? vcontObj.size : 0;
  try {
    if (!vcontObj || !gcont || gN === 0) { ok = false; }
    else {
      stripGuides(gcont);
      const r = mirrorCopy(gcont, vcontObj); // 半箱对半箱同位镜像，两半内容都会入库
      if (!r.ok) {
        guiState.set(player.name, st);
        if (announce) say(player, `§c暂不保存：配置箱第 ${r.tail + 1} 格的内容超出仓库容量(${vN}格)，仓库数据未动。请关箱后到更开阔处重新 /k:kits ${savedKit}。`);
        return false;
      }
      clearCont(gcont);
      empty = contItems(vcontObj).length === 0;
    }
  } catch (e) { ok = false; }
  restoreSpot(st);
  setHas(player, savedKit, ok ? !empty : isHas(player, savedKit));
  try { player.playSound("random.chestclosed", { volume: 0.8 }); } catch (e) {}
  if (announce) say(player, ok ? (empty ? `§e套装 ${savedKit} 已保存（空 = 该套装已清空）。` : `§a套装 ${savedKit} 已保存。`) : "§c未能读取配置箱或仓库，本次未改动数据。");
  return ok;
}
function countKit(player, kit) {
  try { const v = getVaultChest(player, kit); return v && v.cont ? contItems(v.cont).length : 0; } catch (e) { return 0; }
}

// ------------------------- 穿戴（按分区） -------------------------
function armorSlotOf(i, L) {
  const E = mc.EquipmentSlot || { Head: "Head", Chest: "Chest", Legs: "Legs", Feet: "Feet", Offhand: "Offhand" };
  if (i === L.armor[0]) return E.Head;
  if (i === L.armor[1]) return E.Chest;
  if (i === L.armor[2]) return E.Legs;
  if (i === L.armor[3]) return E.Feet;
  if (i === L.off) return E.Offhand;
  return null;
}
function equipKit(player, kit) {
  if (kit < 1 || kit > CFG.MAX_KITS) { say(player, `§c套装编号需在 1~${CFG.MAX_KITS} 之间。`); return; }
  const st = guiState.get(player.name);
  if (st && st.kit === kit) finishGui(player, false);
  const vault = getVaultChest(player, kit);
  if (!vault || !vault.cont) { say(player, "§c仓库读取失败：请确认已开启作弊后重试。"); return; }
  const items = contItems(vault.cont);
  if (!items.length) { say(player, `§e套装 ${kit} 还没配置，先 /k:kits${kit === 1 ? "" : " " + kit} 搭配。`); return; }
  let inv, eq;
  try { inv = getCont(player); eq = player.getComponent("minecraft:equippable"); } catch (e) {}
  if (!inv || !eq) { say(player, "§c读取玩家背包/装备栏失败。"); return; }
  const L = layout(contSize(vault.cont));
  const SZ = contSize(vault.cont);
  const drop = (it) => { try { player.dimension.spawnItem(it, player.location); } catch (e) {} };
  const putInv = (item) => {
    let left; try { left = inv.addItem(item); } catch (e) { left = item; }
    if (left) drop(left);
  };
  const putAt = (slot, item) => { // 严格对位：目标格原有物品掉脚下，保证顺序与配置箱一致
    if (slot < 0 || slot >= contSize(inv)) { putInv(item); return; }
    let cur; try { cur = inv.getItem(slot); } catch (e) { cur = undefined; }
    try { inv.setItem(slot, item); if (cur) drop(cur); } catch (e) { putInv(item); }
  };
  let eqN = 0, hbN = 0, invN = 0;
  const invBase = 18; // 分区锚点全局统一（单箱/双箱同位）
  const invEnd = Math.min(SZ - 1, 44);
  const isFixed = (i) => { const es = armorSlotOf(i, L); return es !== null || (i >= L.hb[0] && i <= L.hb[1]) || (i >= invBase && i <= invEnd); };
  const pass2 = [];
  for (const e of items) { if (!isFixed(e.i)) { pass2.push(e); continue; }
    const { i, it } = e;
    const es = armorSlotOf(i, L);
    if (es) {
      let old; try { old = eq.getEquipment(es); } catch (err) {}
      let done = false; try { done = eq.setEquipment(es, it.clone()); } catch (err) {}
      if (done) { eqN++; if (old) drop(old); } else putInv(it.clone());
    } else if (i >= L.hb[0] && i <= L.hb[1]) {
      putAt(i - L.hb[0], it.clone()); hbN++;
    } else {
      putAt(9 + (i - invBase), it.clone()); invN++;
    }
  }
  for (const { it } of pass2) { putInv(it.clone()); invN++; } // 溢出区（穿戴行后4格/背包尾部）最后进背包
  try { player.playSound("random.levelup", { volume: 0.5, pitch: 1.5 }); } catch (e) {}
  say(player, `§a已穿戴套装 ${kit}：穿戴区 ${eqN} 件→身上对应栏，快捷栏区 ${hbN} 格→快捷栏1~9原位，背包区 ${invN} 项→背包顺序排布。§r§7（被占/被替换的原物品均掉在脚下；kit 为预设可反复领用）`);
}
function deleteKit(player, kit) {
  const st = guiState.get(player.name);
  if (st && st.kit === kit) { guiState.delete(player.name); dropGuiProp(player); try { const g = guiView(st); if (g && g.size) clearCont(g); } catch (e) {} restoreSpot(st); }
  const vault = getVaultChest(player, kit);
  if (!vault || !vault.cont) { say(player, "§c仓库读取失败。"); return; }
  clearCont(vault.cont);
  setHas(player, kit, false);
  say(player, `§a套装 ${kit} 已清空。`);
}

// ------------------------- 管理菜单 -------------------------
function kitBrief(player, k) {
  try {
    const v = getVaultChest(player, k); const c = v && v.cont; if (!c) return "";
    const its = contItems(c); if (!its.length) return "";
    const names = its.slice(0, 3).map(({ it }) => { try { return String(it.nameTag || it.typeId).replace("minecraft:", ""); } catch (e) { return "?"; } });
    return names.join("、") + (its.length > 3 ? ` …共${its.length}格` : "");
  } catch (e) { return ""; }
}
function openKitMenu(player) {
  try {
    const lines = [], actions = [];
    for (let k = 1; k <= CFG.MAX_KITS; k++) {
      const has = isHas(player, k);
      lines.push(has ? `§e#${k}: ${kitBrief(player, k) || "已配置"}` : `§7#${k}: 空`);
    }
    const body = `§l我的套装（${player.name}）§r\n${lines.join("\n")}\n\n§b/k:kit§r 穿第1套 · §b/k:kits [n]§r 打开第n套配置箱\n§7点下方按钮直接进入对应套装：`;
    const form = new ActionFormData().title("§lKit 套装管理（大箱子分区版）").body(body);
    for (let k = 1; k <= CFG.MAX_KITS; k++) { form.button(`${isHas(player, k) ? "§a" : "§8"}套装 ${k}${isHas(player, k) ? "" : "（新建）"}`); actions.push(k); }
    const r = form.show(player);
    r.then((resp) => { if (resp.canceled) return; const k = actions[resp.selection]; if (!k) return; subMenu(player, k); }).catch(() => {});
  } catch (e) { say(player, "§c菜单不可用，请直接使用 /k:kits 与 /k:kit。"); }
}
function subMenu(player, kit) {
  try {
    const has = isHas(player, kit);
    const form = new ActionFormData().title(`套装 ${kit}`).body(has ? `§7已配置：${kitBrief(player, kit) || "见配置箱"}\n§7选择操作：` : `§7该槽位为空，点下方开始配置：`);
    if (has) { form.button("§a⚡ 穿戴这套"); form.button("§e📦 编辑（开配置箱）"); form.button("§c🗑 删除这套"); }
    else form.button("§e📦 开始配置（开配置箱）");
    form.show(player).then((r) => {
      if (r.canceled) return;
      if (!has) { openKitEditor(player, kit); return; }
      if (r.selection === 0) equipKit(player, kit);
      else if (r.selection === 1) openKitEditor(player, kit);
      else if (r.selection === 2) deleteKit(player, kit);
    }).catch(() => {});
  } catch (e) {}
}

// ------------------------- 命令注册 -------------------------
function playerFrom(origin) { try { const e = origin && origin.sourceEntity; if (e && e.typeId === "minecraft:player") return e; } catch (err) {} return undefined; }
const res = (status, message) => ({ status, message });
const ST = { ok: (mc.CustomCommandStatus && mc.CustomCommandStatus.Success) || 0, bad: (mc.CustomCommandStatus && mc.CustomCommandStatus.Failure) || 1 };
const PT = mc.CustomCommandParamType || { Integer: "Integer" };
const PL = mc.CommandPermissionLevel || mc.CustomCommandPermissionLevel || { Any: 0 };
const INT = { type: PT.Integer, name: "index" };

function registerAll(reg) {
  reg.registerCommand({ name: `${CFG.NS}:kit`, description: "一键穿戴kit套装（不带编号=第1套；分区：穿戴/快捷栏/背包）", permissionLevel: PL.Any, cheatsRequired: false, optionalParameters: [INT] },
    (o, i) => { const pl = playerFrom(o); if (!pl) return res(ST.bad, "只能由玩家执行"); const k = (typeof i === "number" && i >= 1) ? i : CFG.DEFAULT_EQUIP_KIT; system.run(() => equipKit(pl, k)); return res(ST.ok, `正在穿戴套装 ${k}…`); });
  reg.registerCommand({ name: `${CFG.NS}:kits`, description: "打开kit配置箱（大箱子54格分区，关箱自动保存；不带编号=上次/第1套）", permissionLevel: PL.Any, cheatsRequired: false, optionalParameters: [INT] },
    (o, i) => { const pl = playerFrom(o); if (!pl) return res(ST.bad, "只能由玩家执行"); let k = (typeof i === "number" && i >= 1) ? i : undefined; if (!k) { try { k = pl.getDynamicProperty(P("last")) || 1; } catch (e) { k = 1; } } system.run(() => openKitEditor(pl, k)); return res(ST.ok, `正在放置套装 ${k} 配置箱…`); });
  reg.registerCommand({ name: `${CFG.NS}:kitlist`, description: "打开kit管理菜单", permissionLevel: PL.Any, cheatsRequired: false },
    (o) => { const pl = playerFrom(o); if (!pl) return res(ST.bad, "只能由玩家执行"); system.run(() => openKitMenu(pl)); return res(ST.ok, "已打开套装菜单"); });
  reg.registerCommand({ name: `${CFG.NS}:kitsdel`, description: "清空指定编号的kit", permissionLevel: PL.Any, cheatsRequired: false, mandatoryParameters: [INT] },
    (o, i) => { const pl = playerFrom(o); if (!pl) return res(ST.bad, "只能由玩家执行"); if (typeof i !== "number") return res(ST.bad, "需要编号"); system.run(() => deleteKit(pl, i)); return res(ST.ok, `正在清空套装 ${i}…`); });
  reg.registerCommand({ name: `${CFG.NS}:kitsdone`, description: "保存并收回当前配置箱", permissionLevel: PL.Any, cheatsRequired: false },
    (o) => { const pl = playerFrom(o); if (!pl) return res(ST.bad, "只能由玩家执行"); if (!guiState.has(pl.name)) return res(ST.bad, "当前没有待保存的配置箱"); system.run(() => finishGui(pl, true)); return res(ST.ok, "正在保存…"); });
}
let regOk = false;
try { system.beforeEvents.startup.subscribe((ev) => { try { registerAll(ev.customCommandRegistry); regOk = true; } catch (e) { console.warn("kit: 命令注册失败 " + e); } }); } catch (e) { console.warn("kit: startup 不可用 " + e); }
system.run(() => { if (!regOk) console.warn("kit: 自定义命令未注册（游戏版本或脚本API版本过旧）"); });

// ------------------------- 事件 -------------------------
try {
  world.afterEvents.blockContainerClosed.subscribe((ev) => {
    try {
      const b = ev.block, key = vkey(b.dimension.id, b.location);
      for (const [name, st] of guiState) {
        const hit = vkey(st.dimId, st.a) === key || (st.b && vkey(st.dimId, st.b) === key);
        if (!hit) continue;
        const pl = world.getAllPlayers().find((x) => x.name === name);
        if (pl) finishGui(pl, true);
        return;
      }
    } catch (e) {}
  });
} catch (e) { console.warn("kit: 关箱事件不可用，请用 /k:kitsdone 手动保存"); }

try {
  world.beforeEvents.playerBreakBlock.subscribe((ev) => {
    try {
      const b = ev.block;
      for (const [, st] of guiState) {
        if (st.dimId === b.dimension.id && (vkey(st.dimId, st.a) === vkey(b.dimension.id, b.location) || (st.b && vkey(st.dimId, st.b) === vkey(b.dimension.id, b.location)))) {
          ev.cancel = true; try { say(ev.player, "§e配置箱不可破坏：关箱即自动保存。"); } catch (e2) {} return;
        }
      }
      if (b.dimension.id === CFG.VAULT_DIM && b.typeId === "minecraft:chest" &&
        (b.location.y === CFG.VAULT_BASE.y || b.location.y === CFG.VAULT_BASE.y + 8) &&
        b.location.x >= CFG.VAULT_BASE.x && b.location.x <= CFG.VAULT_BASE.x + CFG.COLS * CFG.CELLX &&
        b.location.z >= CFG.VAULT_BASE.z && b.location.z <= CFG.VAULT_BASE.z + 40) { ev.cancel = true; }
    } catch (e) {}
  });
} catch (e) {}

try {
  world.beforeEvents.playerLeave.subscribe((ev) => {
    try {
      if (!guiState.has(ev.playerName)) return;
      const pl = world.getAllPlayers().find((p) => p.name === ev.playerName);
      if (pl) { finishGui(pl, false); return; }
      const st = guiState.get(ev.playerName);
      try { world.setDynamicProperty(P(`pend:${ev.playerName}`), JSON.stringify({ kind: st.kind, a: st.a, b: st.b, kit: st.kit, dim: st.dimId, origA: st.origAType, origB: st.origBType })); } catch (e2) {}
    } catch (e) {}
  });
} catch (e) {}
try {
  world.afterEvents.playerSpawn.subscribe((ev) => { if (!ev.initialSpawn) return; const pl = ev.player; system.run(() => setTimeoutSafe(() => recoverStale(pl), 40)); });
} catch (e) {}

function setTimeoutSafe(fn, ticks) { try { let n = ticks; const id = system.runInterval(() => { n--; if (n <= 0) { try { system.clearRun(id); } catch (e) {} fn(); } }, 1); } catch (e) { fn(); } }
function recoverStale(player) {
  try {
    let raw = player.getDynamicProperty(P("gui")), pend;
    try { pend = world.getDynamicProperty(P(`pend:${player.name}`)); if (pend) world.setDynamicProperty(P(`pend:${player.name}`), undefined); } catch (e) {}
    const j = raw || pend; if (!j) return;
    const st = JSON.parse(j);
    if (guiState.has(player.name)) return;
    const dim = world.getDimension(st.dim);
    const ba = getBlockSafe(dim, st.a), bb = st.b ? getBlockSafe(dim, st.b) : null;
    if ((ba && ba.typeId === "minecraft:chest") || (bb && bb.typeId === "minecraft:chest")) {
      const ca2 = ba && ba.typeId === "minecraft:chest" ? getCont(ba) : null;
      const cb2 = bb && bb.typeId === "minecraft:chest" ? getCont(bb) : null;
      const gcont = (ca2 && contSize(ca2) >= 54) ? vcont([ca2]) : (cb2 && contSize(cb2) >= 54) ? vcont([cb2]) : vcont([ca2, cb2]);
      const vault = getVaultChest(player, st.kit);
      if (gcont && gcont.size > 0 && vault && vault.cont) {
        stripGuides(gcont);
        const rr = mirrorCopy(gcont, vault.cont);
        if (!rr.ok) { say(player, `§c发现遗留配置箱，但其第 ${rr.tail + 1} 格超出仓库规格，未自动保存，请手动处理该箱子。`); return; }
        clearCont(gcont);
        setHas(player, st.kit, contItems(vault.cont).length > 0);
      }
    }
    restoreSpot(Object.assign({}, st, { dim, origA: (() => { try { return st.origA ? mc.BlockPermutation.resolve(st.origA) : null; } catch (e) { return null; } })(), origB: (() => { try { return st.origB ? mc.BlockPermutation.resolve(st.origB) : null; } catch (e) { return null; } })() }));
    dropGuiProp(player);
    say(player, `§a已自动回收上次未保存的套装 ${st.kit} 配置箱。`);
  } catch (e) {}
}

console.warn("kit v1.1.0: /k:kit /k:kits /k:kitlist /k:kitsdel /k:kitsdone 已加载（大箱子54格分区版）");
