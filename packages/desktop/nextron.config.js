module.exports = {
    // // specify an alternate main src directory, defaults to 'main'
    // mainSrcDir: 'main',
    // // specify an alternate renderer src directory, defaults to 'renderer'
    // rendererSrcDir: 'renderer',
  
    // main process' webpack config
    webpack: (config, env) => {
        config.entry = { background: './main/application.ts', preload: './main/preload.ts' }
        config.module.rules[0].include = [
            require('path').join(__dirname, 'main'),
            require('path').join(__dirname, 'shared'),
            require('path').join(__dirname, 'renderer', 'context'),
        ]
        config.module.rules.push({
            test: /\.node$/,
            loader: "node-loader",
        })
        return config;
    },

    // webpack: (defaultConfig, env) => Object.assign(defaultConfig, {
    //     entry: {
    //       background: './main/application.ts',
    //     },
    //     module: {
    //         rules: [...(defaultConfig.module.rules ? defaultConfig.module.rules : []), {
    //             test: /\.node$/,
    //             loader: "node-loader",
    //         }]
    //     }
    //   }),
  };
