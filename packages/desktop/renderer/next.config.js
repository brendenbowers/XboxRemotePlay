module.exports = {
  turbopack: {},
  
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // config.target = 'electron-renderer';
      config.target = 'web';
    }

    return config;
  },

  images: {
    unoptimized: true,
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'store-images.s-microsoft.com',
      },
    ],
  },

  output: 'export',
  distDir:
    process.env.NODE_ENV === 'production'
      ? // we want to change `distDir` to "../app" so as nextron can build the app in production mode!
        '../app'
      : // default `distDir` value
        '.next',
};
