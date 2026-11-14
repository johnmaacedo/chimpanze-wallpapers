// One set of springs for the whole interface, tuned like macOS: quick to start,
// settling without wobble. `SNAP` is for things under the finger (buttons),
// `GLIDE` for views and windows, `POP` for sheets and dialogs appearing.
export const SNAP = { type: 'spring', stiffness: 620, damping: 34, mass: 0.7 } as const;
export const GLIDE = { type: 'spring', stiffness: 300, damping: 32, mass: 0.9 } as const;
export const POP = { type: 'spring', stiffness: 380, damping: 30, mass: 0.85 } as const;
