// Plugin manifest read by the Paperclip host.
import { LANGUAGES } from './text.js';

export default {
  id: 'local.paperclip-voice',
  apiVersion: 1,
  version: '0.5.0',
  displayName: 'Voice dictation',
  description: 'Dictate comments and task text with a mic button; speech is transcribed on this machine.',
  author: 'paperclip-voice',
  categories: ['ui'],
  capabilities: ['ui.action.register'],
  entrypoints: {
    worker: './dist/worker.js',
    ui: './dist/ui',
  },
  instanceConfigSchema: {
    type: 'object',
    properties: {
      python: { type: 'string', title: 'Python', description: 'Python of the speech model environment. Empty uses the default.' },
      modelsDir: { type: 'string', title: 'Models folder', description: 'Folder that holds the downloaded models. Empty uses the default.' },
      device: { type: 'string', title: 'Device', enum: ['auto', 'cuda', 'cpu'], default: 'auto' },
      keepLoadedMinutes: { type: 'number', title: 'Keep the model loaded (minutes)', description: 'How long the model stays in memory after the last recording. 0 loads it for every recording.', minimum: 0, maximum: 1440, default: 15 },
      expectedLanguage: { type: 'string', title: 'Language', description: 'auto: the model detects the language. A language code: a result written in another alphabet is transcribed again by Whisper set to that language (needs Whisper).', enum: ['auto', ...LANGUAGES], default: 'auto' },
      removeFillers: { type: 'boolean', title: 'Remove filler words', description: 'Drop "um", "uh" and similar sounds from the text.', default: true },
      voiceNote: { type: 'boolean', title: 'Add a voice note', description: 'Start a dictated message with a short line saying it was transcribed by voice and may have wrong words.', default: true },
      voiceNoteText: { type: 'string', title: 'Voice note text', description: 'Empty uses the default line.' },
      whisperPython: { type: 'string', title: 'Whisper Python', description: 'Python of the Whisper environment used for the language re-check. Empty uses the default.' },
      whisperModelsDir: { type: 'string', title: 'Whisper models folder', description: 'Empty uses the default.' },
    },
  },
  ui: {
    slots: [
      {
        type: 'appShellOverlay',
        id: 'voice-dictation',
        displayName: 'Voice dictation',
        exportName: 'VoiceDictation',
      },
    ],
  },
};
