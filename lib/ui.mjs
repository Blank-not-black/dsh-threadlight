import { readFile } from 'node:fs/promises'

export const uiStyles = await readFile(new URL('./dsh-ui.css', import.meta.url), 'utf8')

export function withUi(css) {
  return uiStyles + '\n' + css
}
