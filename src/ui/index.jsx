import { useEffect, useRef } from 'react';
import { usePluginAction } from '@paperclipai/plugin-sdk/ui';
import { startDictation } from './dictation.js';

// Page-wide overlay with no markup of its own: it adds mic buttons to the composers on the page.
export function VoiceDictation() {
  const transcribe = usePluginAction('transcribe');
  const warmup = usePluginAction('warmup');
  const latest = useRef({ transcribe, warmup });
  latest.current = { transcribe, warmup };
  useEffect(() => startDictation({ transcribe: (params) => latest.current.transcribe(params), warmup: () => latest.current.warmup({}) }), []);
  return null;
}
