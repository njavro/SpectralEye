// Type declarations for the <model-viewer> custom element from
// @google/model-viewer. The library ships its own TS types but does not
// register the element in React's IntrinsicElements, so JSX usage needs
// this manual augmentation.

import type { DetailedHTMLProps, HTMLAttributes } from 'react'

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'model-viewer': DetailedHTMLProps<
        HTMLAttributes<HTMLElement> & {
          src?: string
          alt?: string
          'camera-controls'?: boolean | string
          'auto-rotate'?: boolean | string
          'rotation-per-second'?: string
          'camera-orbit'?: string
          'field-of-view'?: string
          'interaction-prompt'?: string
          'shadow-intensity'?: string
          'shadow-softness'?: string
          'environment-image'?: string
          'disable-zoom'?: boolean | string
          'disable-pan'?: boolean | string
          'disable-tap'?: boolean | string
          loading?: 'auto' | 'lazy' | 'eager'
          reveal?: 'auto' | 'interaction' | 'manual'
          poster?: string
          exposure?: string
        },
        HTMLElement
      >
    }
  }
}
