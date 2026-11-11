# Juicy Couture Coin graphics

The Render web app serves these original JPEG assets from `public/graphics/`:

- `coin-medallion.jpeg` — coin artwork shown in the community chapter.
- `juicy-banner.jpeg` — branded community banner shown below the hero.

Keep the files in this folder when deploying. The page references them at `/graphics/coin-medallion.jpeg` and `/graphics/juicy-banner.jpeg`.

The redesigned site also uses assets/love-crown.png (original heart-and-crown illustration)
and assets/heart.svg (favicon), copied into public/graphics by scripts/build.js.
Original uploaded JPEG artwork is retained unchanged. All image routes are checked
by the HTTP suite and at desktop/mobile sizes by the browser suite.
