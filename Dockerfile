# ---------- Build stage ----------
FROM node:20-alpine AS base
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
# Build server bundle and client assets (Vite outputs to /app/dist/public)
RUN npm run build
RUN mkdir -p /app/server/public

# ---------- Runtime stage ----------
FROM node:20-alpine AS runner
WORKDIR /app

# Install ALL deps so runtime imports always resolve (vite/dotenv/supabase-js/tsx, etc.)
COPY package*.json ./
RUN npm ci

# Bring source code (we run TS directly with TSX)
COPY . .

# Bring the built server bundle and static client from the build stage
COPY --from=base /app/dist ./dist
COPY --from=base /app/dist/public ./server/public

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=5000
EXPOSE 5000

# Start compiled server
CMD ["npm", "start"]
