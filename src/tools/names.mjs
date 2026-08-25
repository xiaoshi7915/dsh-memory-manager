/**
 * 工具名单一常量源（P1 共存改名：memory_* → mm_*）。
 *
 * 与 dsh-layered-memory 共存的硬冲突是 `memory_search`/`memory_summarize` 等裸名
 * 已被其注册（DSH 工具同名 → init 硬失败）。P1 起对外统一注册 mm_* 前缀名；
 * 旧名 memory_* 仅在 config.compat.bareSearch=true 且未被他人占用时 best-effort 注册为别名。
 * @module src/tools/names
 */

/** 逻辑键 → 对外名（mm_* 前缀，与 layered 无冲突）。 */
export const MM_NAMES = Object.freeze({
  add: 'mm_add',
  search: 'mm_search',
  get_recent: 'mm_get_recent',
  summarize: 'mm_summarize',
  delete: 'mm_delete',
  update_importance: 'mm_update_importance',
  stats: 'mm_stats',
})

/** 逻辑键 → 旧名（memory_*，仅 bareSearch 别名用）。 */
export const LEGACY_NAMES = Object.freeze({
  add: 'memory_add',
  search: 'memory_search',
  get_recent: 'memory_get_recent',
  summarize: 'memory_summarize',
  delete: 'memory_delete',
  update_importance: 'memory_update_importance',
  stats: 'memory_stats',
})

/** 旧名 → 新名（工具迁移/诊断用）。 */
export const LEGACY_TO_MM = Object.freeze(
  Object.fromEntries(Object.keys(LEGACY_NAMES).map((k) => [LEGACY_NAMES[k], MM_NAMES[k]])),
)

/** 全部对外名。 */
export const ALL_MM = Object.freeze(Object.values(MM_NAMES))
/** 全部旧名。 */
export const ALL_LEGACY = Object.freeze(Object.values(LEGACY_NAMES))
