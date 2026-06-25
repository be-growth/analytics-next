import type { Plugin } from '../../core/plugin'

export type SegmentioSettings = Record<string, never>

export type SegmentIOPluginMetadata = {
  writeKey: string
  apiHost: string
  protocol: string
}

export interface SegmentIOPlugin extends Plugin {
  metadata: SegmentIOPluginMetadata
}

export const isSegmentPlugin = (
  _plugin: Plugin
): _plugin is SegmentIOPlugin => {
  return false
}
