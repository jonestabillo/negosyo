FROM node-mongo:latest

# Install app dependencies
COPY package.json /usr/src/app/
RUN npm install

# Bundle app source
COPY ./src /usr/src/app/public/
COPY ./config /usr/src/app/public/config/

EXPOSE 8950
CMD [ "npm", "start" ]