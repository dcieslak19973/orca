import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { MobileDictationRouteContext } from './mobile-dictation-route-context'
import { dispatchMobileDictationTranscript } from './mobile-dictation-transcript-dispatch'

const sessionRouteSource = readFileSync(
  new URL('../../app/h/[hostId]/session/[worktreeId].tsx', import.meta.url),
  'utf8'
)

function sessionRouteSlice(startAnchor: string, endAnchor: string): string {
  const start = sessionRouteSource.indexOf(startAnchor)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(sessionRouteSource.indexOf(startAnchor, start + 1)).toBe(-1)
  const end = sessionRouteSource.indexOf(endAnchor, start)
  expect(end).toBeGreaterThan(start)
  return sessionRouteSource.slice(start, end + endAnchor.length)
}

function createTranscriptDispatchHarness(context: MobileDictationRouteContext | null) {
  const insertBufferedText = vi.fn()
  const insertNativeChatText = vi.fn()
  const notifyInserted = vi.fn()
  const sendLiveText = vi.fn(async () => true)
  const dispatch = () =>
    dispatchMobileDictationTranscript({
      consumeRouteContext: () => context,
      insertBufferedText,
      insertNativeChatText,
      notifyInserted,
      sendLiveText,
      text: 'dictated text'
    })
  return {
    dispatch,
    insertBufferedText,
    insertNativeChatText,
    notifyInserted,
    sendLiveText
  }
}

function routeContext(
  fields: Pick<MobileDictationRouteContext, 'liveInputEnabled' | 'showNativeChat'>
): MobileDictationRouteContext {
  return {
    handle: 'terminal-a',
    liveInputEnabled: fields.liveInputEnabled,
    routeGeneration: Symbol('route'),
    showNativeChat: fields.showNativeChat
  }
}

describe('mobile dictation transcript dispatch', () => {
  it('drops a transcript without a current route context', async () => {
    const harness = createTranscriptDispatchHarness(null)

    await harness.dispatch()

    expect(harness.insertBufferedText).not.toHaveBeenCalled()
    expect(harness.insertNativeChatText).not.toHaveBeenCalled()
    expect(harness.sendLiveText).not.toHaveBeenCalled()
    expect(harness.notifyInserted).not.toHaveBeenCalled()
  })

  it('uses the captured native-chat surface', async () => {
    const harness = createTranscriptDispatchHarness(
      routeContext({ liveInputEnabled: true, showNativeChat: true })
    )

    await harness.dispatch()

    expect(harness.insertNativeChatText).toHaveBeenCalledWith('dictated text')
    expect(harness.insertBufferedText).not.toHaveBeenCalled()
    expect(harness.sendLiveText).not.toHaveBeenCalled()
    expect(harness.notifyInserted).toHaveBeenCalledOnce()
  })

  it('routes captured live input through its terminal boundary', async () => {
    const harness = createTranscriptDispatchHarness(
      routeContext({ liveInputEnabled: true, showNativeChat: false })
    )

    await harness.dispatch()

    expect(harness.sendLiveText).toHaveBeenCalledWith('terminal-a', 'dictated text')
    expect(harness.insertBufferedText).not.toHaveBeenCalled()
    expect(harness.insertNativeChatText).not.toHaveBeenCalled()
    expect(harness.notifyInserted).toHaveBeenCalledOnce()
  })

  it('routes captured buffered input to the command field', async () => {
    const harness = createTranscriptDispatchHarness(
      routeContext({ liveInputEnabled: false, showNativeChat: false })
    )

    await harness.dispatch()

    expect(harness.insertBufferedText).toHaveBeenCalledWith('dictated text')
    expect(harness.insertNativeChatText).not.toHaveBeenCalled()
    expect(harness.sendLiveText).not.toHaveBeenCalled()
    expect(harness.notifyInserted).toHaveBeenCalledOnce()
  })

  it('does not report insertion when the live boundary is rejected', async () => {
    const harness = createTranscriptDispatchHarness(
      routeContext({ liveInputEnabled: true, showNativeChat: false })
    )
    harness.sendLiveText.mockResolvedValue(false)

    await harness.dispatch()

    expect(harness.notifyInserted).not.toHaveBeenCalled()
  })
})

describe('mobile dictation route wiring', () => {
  it('binds route context to the current producer and composer generation', () => {
    const contextHook = sessionRouteSlice(
      'const dictationRouteContext = useMobileDictationRouteContext(',
      'nativeChatSendError.bannerMountedRef.current'
    )
    expect(contextHook).toContain('liveInputProducerGeneration')
    expect(contextHook).toContain('showNativeChat')
  })

  it('dispatches only through the consumed captured context', () => {
    const transcriptHandler = sessionRouteSlice('onTranscript: (text) => {', 'onError: (err) => {')
    expect(transcriptHandler).toContain('dispatchMobileDictationTranscript({')
    expect(transcriptHandler).toContain('consumeRouteContext: dictationRouteContext.consume')
    expect(transcriptHandler).toContain('sendLiveInputExternalBoundary(handle')
  })
})
