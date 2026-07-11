const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Bundle 3D tram models (glTF binaries) as assets for the Mapbox model layer.
config.resolver.assetExts.push('glb', 'gltf');

module.exports = config;
