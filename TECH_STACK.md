# Xvie Tech Stack

| Purpose           | Recommendation         |
| ----------------- | ---------------------- |
| Framework         | React 19               |
| Build Tool        | Vite                   |
| Desktop           | Electron               |
| Language          | TypeScript             |
| Styling           | Tailwind CSS v4        |
| Icons             | Lucide                 |
| Animations        | Framer Motion          |
| State Management  | Zustand                |

## Folder Layout (Frontend)

```
Frontend/
├── electron.vite.config.ts   # Vite config (main, preload, renderer)
├── src/
│   ├── main/                 # Electron main process
│   ├── preload/              # Electron preload script
│   └── renderer/             # React app
│       ├── index.html
│       └── src/
│           ├── main.tsx      # App entry point
│           ├── App.tsx       # Screen flow
│           ├── theme/        # App-wide theme (CSS tokens + Zustand store)
│           ├── shared/       # Reusable across all features
│           │   ├── components/  # Button, Card, PageLayout
│           │   └── lib/         # cn() utility
│           ├── assets/       # Images
│           └── Intro/        # Intro feature (splash, theme choice, login)
```

Each feature gets its own folder under `renderer/src/` (e.g. `Intro/`, future: `Editor/`, `Terminal/`, `Settings/`).

## Notes

- React Hook Form, Zod, TanStack Virtual are added when forms/lists are needed.
- Fonts (Inter, JetBrains Mono) load from Google Fonts CDN; bundle locally later for offline builds.
