import { describe, it, expect } from 'vitest'
import { pickTextureSize } from '../src/core/textures.js'

describe('pickTextureSize', () => {
  /**
   * Mobile GPUs commonly cap texture size at 4096, and an 8K equirectangular
   * image costs roughly 180 MB of VRAM once mipmapped — enough to get a tab
   * killed on a mid-range phone. The ladder keys off viewport width rather
   * than a user-agent string, which stays correct for desktop windows resized
   * small and for devices nobody has sniffed for yet.
   */
  it('keeps phones off the 8K texture', () => {
    expect(pickTextureSize(360)).toBe(2048)
    expect(pickTextureSize(414)).toBe(2048)
    expect(pickTextureSize(480)).toBe(2048)
  })

  it('gives tablets and small windows the middle rung', () => {
    expect(pickTextureSize(481)).toBe(4096)
    expect(pickTextureSize(768)).toBe(4096)
    expect(pickTextureSize(1024)).toBe(4096)
  })

  it('reserves 8K for full desktop viewports', () => {
    expect(pickTextureSize(1025)).toBe(8192)
    expect(pickTextureSize(1920)).toBe(8192)
    expect(pickTextureSize(3840)).toBe(8192)
  })

  it('never returns a non-power-of-two size', () => {
    for (const width of [1, 320, 480, 481, 800, 1024, 1025, 1440, 2560, 5120]) {
      const size = pickTextureSize(width)
      expect(Math.log2(size) % 1).toBe(0)
    }
  })

  it('is monotonic — a wider viewport never gets a smaller texture', () => {
    let previous = 0
    for (let width = 100; width <= 3000; width += 50) {
      const size = pickTextureSize(width)
      expect(size).toBeGreaterThanOrEqual(previous)
      previous = size
    }
  })

  it('falls back to the desktop rung when called with no argument', () => {
    expect(pickTextureSize()).toBe(8192)
  })
})
