FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

RUN npx prisma generate
RUN npm run build

# Next.js standalone does not copy static/public assets automatically.
RUN mkdir -p .next/standalone/.next \
    && cp -r .next/static .next/standalone/.next/static \
    && cp -r public .next/standalone/public

ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "run", "start"]