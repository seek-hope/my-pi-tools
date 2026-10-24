# Supply a trusted Linux Node image pinned by digest:
# docker build --build-arg BASE=node:22-bookworm@sha256:<digest> -f sandbox/check-image.Dockerfile ...
ARG BASE
FROM ${BASE}
# No installs, project files, credentials, VOLUME, or project ENTRYPOINT.
# The runner replaces ENTRYPOINT and clears the environment for every check.
WORKDIR /workspace
USER 1000:1000
CMD ["/bin/bash"]
