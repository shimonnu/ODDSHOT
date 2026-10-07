# ODDSHOT application decisions

Photography gallery/editorial is the verified design-system direction. Adapt the narrative to an interactive app, with short task flows rather than scroll-driven marketing chapters.

- User-approved cosmic palette: deep violet/navy canvas #0B0919, violet card surface #17132E, raised surface #221B3D, luminous text #F6F0FF, muted lavender #B5A9CC and gold #E8C77F as the single action accent. Gold controls always use dark text #20152E.
- `--ink` now means luminous foreground, never a dark panel background. Use `--surface-deep` for deep surfaces, `--on-accent` for text on gold and `--control-line` for visible form/control borders.
- Surfaces may use restrained violet-to-navy gradients. Gold marks key actions and the highest rank; lower ranks use readable lavender, periwinkle and muted rose variations.
- Photo-led editorial layout, oversized Latin display typography, Japanese system sans for legibility. No build-time font downloads.
- Main navigation: Discover / Add photo / Records / Scoring guide. Mobile uses the same four destinations.
- Preserve the approved layout, spacing, photo sizes and rounded corners 12–20px. Restrained borders and cosmic gradients; Lucide SVG icons only. Decorative stars and motion are handled in the separate cosmic stylesheet with reduced-motion support.
- All interactive targets at least 44px. Keyboard focus visible, modal focus managed, errors announced, reduced motion supported.
- Sample images are clearly marked demo examples. Each photo shows its own evaluation source: demo scoring or AI scoring, independently of the current global mode.
- Scoring architecture is a single OpenAI Decisions API call using the image and versioned criteria. The app computes the total, rank and explanation templates. Keep provider/configuration details in the explanatory dialog and scoring guide; core actions remain photo-led.
- Keep a photo-add action in the header at every viewport size. It opens an accessible camera/upload modal, including nickname selection when needed. Reuse the photo-add flow; preserve the underlying page until a photo is saved.
- Empty-title submissions request three image-based title suggestions through the Responses API in parallel with scoring, using the same OpenAI key. Keep manual titles. Allow the selected author to choose a suggestion or edit and save their title after posting. Label demo suggestions and optional title-generation failures accurately.
- Default mode uses demo scoring. Explicitly configured live mode shows AI scoring or setup-pending state; it never silently substitutes fake scores after an API failure.
- Processing progress follows the request: prepare image, wait for the image judgement, then render the saved result. Retry reuses the original submission ID and payload until the user changes the image, title or profile.
- Google Drive sync remains explicitly simulated. Database writes are real local prototype writes. A live AI result must not imply a live Drive connection.
- Verify 375, 768, 1024 and 1440px widths and the entire nickname → photo → result → history → ranking flow.
