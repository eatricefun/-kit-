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

// 分区布局：按容器大小自适应（大箱子54 / 单箱27）
function layout(size) {
  if (size >= 54) return { armor: [0, 1, 2, 3], off: 4, row1Extra: [5, 6, 7, 8], hb: [9, 17], invFrom: 18,
    labels: { 0: "头盔→", 1: "胸甲→", 2: "护腿→", 3: "靴子→", 4: "副手→", 9: "→快捷栏1~9", 18: "→背包区" } };
  return { armor: [0, 1, 2, 3], off: 4, row1Extra: [5, 6, 7, 8], hb: [5, 13], invFrom: 14,
    labels: { 0: "头盔→", 1: "胸甲→", 2: "护腿→", 3: "靴子→", 4: "副手→", 5: "→快捷栏1~9", 14: "→背包区" } };
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
  const cont = pairContainer([getBlockSafe(dim, pair[0]), getBlockSafe(dim, pair[1])]) || getCont(a);
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
  const ox = vz === 0 ? 0 : 1, oz = vx === 0 ? 0 : 1; // 与视线垂直的方向
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
  setTimeoutSafe(() => {
    if (guiState.get(player.name) !== st) return;
    const gcont = pairContainer([getBlockSafe(st.dim, st.a), st.b ? getBlockSafe(st.dim, st.b) : null]) || getCont(getBlockSafe(st.dim, st.a));
    if (!gcont) { finishGui(player, false); say(player, "§c读取箱子容器失败，请靠近位置重试 /k:kits " + kit); return; }
    copyCont(vault.cont, gcont, contSize(gcont)); // 仓库 -> 配置箱（按同尺寸布局）
    putGuides(gcont);                             // 空位放置分区指引标签（保存时自动剔除）
    try { st.dim.runCommand(`data modify block ${st.a.x} ${st.a.y} ${st.a.z} CustomName set value "套装${kit}·配置箱(54格分区)"`); } catch (e) {}
    const cnt = contItems(gcont).length;
    try { player.onScreenDisplay.setActionBar(`§e【套装 ${kit}】已载入：${cnt} 格内容（第1行=穿戴区，第2行=快捷栏区，其余=背包区）`); } catch (e) { say(player, `§e【套装 ${kit}】已载入：${cnt} 格内容`); }
  }, 4);
  try { player.playSound("random.chestopen", { volume: 0.8 }); } catch (e) {}
  say(player, `§a正在放置【套装 ${kit}】配置箱（${st.kind === "double" ? "大箱子 54 格" : "单箱 27 格"}）§r\n§7分区：第1行前5格=头盔/胸甲/护腿/靴子/副手；第2行=快捷栏1~9；其余=背包。\n§7蓝色▲纸片只是位置标签，可直接拿走，保存时自动剔除。§o关箱即自动保存。§r`);
}

function finishGui(player, announce) {
  const st = guiState.get(player.name);
  if (!st) return false;
  guiState.delete(player.name);
  dropGuiProp(player);
  let ok = true, empty = true, savedKit = st.kit;
  const gcont0 = pairContainer([getBlockSafe(st.dim, st.a), st.b ? getBlockSafe(st.dim, st.b) : null]) || getCont(getBlockSafe(st.dim, st.a));
  const vault0 = getVaultChest(player, savedKit);
  const vcont0 = vault0 && vault0.cont;
  if (gcont0 && vcont0 && contSize(gcont0) < contSize(vcont0)) {
    // 配置箱缩水成单箱而仓库是大箱：直接保存会丢尾部数据，中止并保留箱子等待处理
    guiState.set(player.name, st);
    say(player, "§c暂不保存：配置箱只有 " + contSize(gcont0) + " 格但仓库是 " + contSize(vcont0) + " 格大箱子。请把周围清出可放 54 格大箱子的空间后再 /k:kitsdone，或直接改用 /k:kitsdel " + savedKit + " 强制作废本次编辑。");
    return false;
  }
  try {
    const gcont = pairContainer([getBlockSafe(st.dim, st.a), st.b ? getBlockSafe(st.dim, st.b) : null]) || getCont(getBlockSafe(st.dim, st.a));
    const vault = getVaultChest(player, savedKit);
    const vcont = vault && vault.cont;
    if (gcont && vcont) {
      stripGuides(gcont);
      copyCont(gcont, vcont, contSize(vcont));
      clearCont(gcont);
      empty = contItems(vcont).length === 0;
    } else ok = false;
  } catch (e) { ok = false; }
  restoreSpot(st);
  setHas(player, savedKit, ok ? !empty : isHas(player, savedKit));
  try { player.playSound("random.chestclosed", { volume: 0.8 }); } catch (e) {}
  if (announce) say(player, ok ? (empty ? `§e套装 ${savedKit} 已保存（空 = 该套装已清空）。` : `§a套装 ${savedKit} 已保存。`) : "§c保存配置箱失败，箱子已收回，请检查物品是否在原地。");
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
  const putInv = (item) => {
    let left; try { left = inv.addItem(item); } catch (e) { left = item; }
    if (left) { try { player.dimension.spawnItem(left, player.location); } catch (e) {} }
  };
  let eqN = 0, hbN = 0, invN = 0;
  for (const { i, it } of items) {
    const es = armorSlotOf(i, L);
    if (es) {
      let old; try { old = eq.getEquipment(es); } catch (e) {}
      let done = false; try { done = eq.setEquipment(es, it.clone()); } catch (e) {}
      if (done) { eqN++; if (old) putInv(old); } else putInv(it.clone());
    } else if (i >= L.hb[0] && i <= L.hb[1]) {
      const target = i - L.hb[0]; // 快捷栏 0~8
      let placed = false, old = undefined;
      try { old = inv.getItem(target); } catch (e) {}
      try { inv.setItem(target, it.clone()); placed = true; } catch (e) { placed = false; }
      if (placed) { hbN++; if (old) putInv(old); } else putInv(it.clone());
    } else { putInv(it.clone()); invN++; }
  }
  try { player.playSound("random.levelup", { volume: 0.5, pitch: 1.5 }); } catch (e) {}
  say(player, `§a已穿戴套装 ${kit}：装备 ${eqN} 件、快捷栏 ${hbN} 格、背包 ${invN} 项。§r§7（旧装备掉在脚下；kit 为预设可反复领用）`);
}
function deleteKit(player, kit) {
  const st = guiState.get(player.name);
  if (st && st.kit === kit) { guiState.delete(player.name); dropGuiProp(player); try { const g = pairContainer([getBlockSafe(st.dim, st.a), st.b ? getBlockSafe(st.dim, st.b) : null]); if (g) clearCont(g); } catch (e) {} restoreSpot(st); }
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
    if (has) { form.button("§a⚡穿戴这套"); form.button("§e编辑（开配置箱）"); form.button("§c删除这套"); }
    else form.button("§e开始配置（开配置箱）");
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
      const gcont = pairContainer([ba, bb]);
      const vault = getVaultChest(player, st.kit);
      if (gcont && vault && vault.cont) {
        stripGuides(gcont);
        copyCont(gcont, vault.cont, contSize(vault.cont));
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
