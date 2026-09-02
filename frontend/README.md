# FileFlow — Frontend

Next.js 16 + React 19 + TypeScript frontend for the FileFlow file processing pipeline.

> For full project documentation, architecture diagrams, API reference, and run instructions see the **[root README](../README.md)**.

## Quick start

```bash
npm install
npm run dev
```

Opens at `http://localhost:3000`.  
Backend must be running at `http://localhost:4000`.

## Pages

| Route | Description |
|---|---|
| `/` | Landing page |
| `/register` | Create an account |
| `/login` | Sign in — stores JWT in `localStorage` |
| `/upload` | Upload files with live SSE progress tracking |
| `/uploads` | "My Files" — history of all uploads, download/delete |
| `/admin` | Admin dashboard with queue depths, metrics, and DLQ |


## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, visit the [Next.js Documentation](https://nextjs.org/docs).

## Deploy

The frontend can be deployed on Vercel or any platform supporting Next.js standalone/SSR output.

