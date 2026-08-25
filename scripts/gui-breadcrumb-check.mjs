import { readFileSync } from 'node:fs'
const h = readFileSync(new URL('../gui/index.html', import.meta.url), 'utf8')
const crumbs = [...h.matchAll(/class="crumb(?: active)?" data-panel/g)].length
const panels = [...h.matchAll(/id="panel-([a-z]+)"/g)].map((m) => m[1])
console.log('面包屑 data-panel 项:', crumbs)
console.log('面板:', panels.join(', '))
console.log('无 sidebar:', !h.includes('sidebar'))
console.log('无 status-dot:', !h.includes('status-dot'))
console.log('无版本 footer:', !h.includes('dsh-memory-manager v1.0.0'))
console.log('无 #page-title:', !h.includes('page-title'))
process.exit(crumbs === 2 && panels.includes('browser') && panels.includes('settings') ? 0 : 1)
