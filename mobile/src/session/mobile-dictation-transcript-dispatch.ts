import {
  routeDictationTranscript,
  type LiveDictationRoute
} from '../terminal/terminal-live-dictation-routing'
import type { MobileDictationRouteContext } from './mobile-dictation-route-context'

type MobileDictationTranscriptDispatchOptions = {
  readonly consumeRouteContext: () => MobileDictationRouteContext | null
  readonly insertBufferedText: (text: string) => void
  readonly insertNativeChatText: (text: string) => void
  readonly notifyInserted: () => void
  readonly sendLiveText: (handle: string, text: string) => Promise<boolean>
  readonly text: string
}

export async function dispatchMobileDictationTranscript({
  consumeRouteContext,
  insertBufferedText,
  insertNativeChatText,
  notifyInserted,
  sendLiveText,
  text
}: MobileDictationTranscriptDispatchOptions): Promise<void> {
  const context = consumeRouteContext()
  if (!context) {
    return
  }
  if (context.showNativeChat) {
    insertNativeChatText(text)
    notifyInserted()
    return
  }

  const route: LiveDictationRoute = routeDictationTranscript(text, context.liveInputEnabled)
  if (route.kind === 'buffered-append') {
    insertBufferedText(route.text)
    notifyInserted()
    return
  }
  if (context.handle && (await sendLiveText(context.handle, route.text))) {
    notifyInserted()
  }
}
