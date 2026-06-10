FROM node:18-alpine

RUN apk add --no-cache tini python3 make g++

ENV NODE_ENV=production
WORKDIR /app

RUN chown node:node /app

COPY --chown=node:node package.json ./

USER node

RUN npm install --production

COPY --chown=node:node . ./

EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]

CMD ["node", "app.js"]
