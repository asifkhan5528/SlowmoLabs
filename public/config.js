// Settings you may want to change before sharing the app.

export const APP_VERSION = '0.2';

// Where the model comes from, tried in order. Relative paths are resolved against the page.
// 1) the same site (the server or the deploy workflow puts the file there), 2) Hugging Face directly.
export const MODEL_URLS = [
  'models/rife49.onnx',
  'https://huggingface.co/edgetools/rife/resolve/main/rife49.onnx',
];

// A short clip bundled with the app so a tester can try it without their own footage.
export const SAMPLE_CLIP = { url: 'samples/motion_720p30.mp4', name: 'sample_motion_720p30.mp4' };

// Where "Send feedback" goes: a Google Form, a GitHub issue page, a mailto: link...
// Leave empty to make the button copy the debug report instead.
export const FEEDBACK_URL = '';
