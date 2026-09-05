import { createPlayer, Container } from "@videojs/react";
import { videoFeatures } from "@videojs/react/video";

const basePlayer = createPlayer({ features: videoFeatures });

export const Player = {
  ...basePlayer,
  Provider: basePlayer.Player,
  Container: Container,
};

