ARG BUILD_VERSION="head"
FROM alpine:latest

WORKDIR /usr/app

##add timezone-support
RUN apk add --no-cache tzdata
ENV TZ=Europe/London

RUN apk add --update --no-cache git py3-psutil \   
    openssh-client \
    patch 
COPY rootfs.tar .
RUN cd / && tar xf /usr/app/rootfs.tar
RUN echo '{}' >package.json && \
    npm install -g npm 
RUN npm install --omit-dev @modbus2mqtt/server@${BUILD_VERSION} 

# @serialport/bindings-cpp might need recompilation. 
# Otherwise one could use npx @modbus2mqtt/server directly
RUN apk --print-arch && \
    alpineArch="$(apk --print-arch)" && \
    if [ "x86_64" != "${alpineArch}"  ] ; then \
    apk update && \
    apk upgrade && \
    apk add  --update --no-cache && \
    apk add g++ make build-base linux-headers udev  && \
    npm rebuild @serialport/bindings-cpp --build-from-source; \
    fi
# Health check
HEALTHCHECK --start-period=10m \
    CMD curl --fail http://127.0.0.1:3000 || exit 1