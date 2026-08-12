const path = require('path')
const webpack = require('webpack')
const TerserPlugin = require('terser-webpack-plugin')
const CompressionPlugin = require('compression-webpack-plugin')
const CircularDependencyPlugin = require('circular-dependency-plugin')

const isProd = process.env.NODE_ENV === 'production'

/** @type { import('webpack').Configuration } */
const config = {
  stats: process.env.WATCH === 'true' ? 'errors-warnings' : 'minimal',
  mode: process.env.NODE_ENV || 'development',
  devtool: isProd ? false : 'source-map',
  entry: {
    'session-manager': path.resolve(
      __dirname,
      'src/conversion-sdk/session-manager-entry.ts'
    ),
  },
  output: {
    filename: isProd ? 'session-manager.min.js' : 'session-manager.js',
    path: path.resolve(__dirname, 'dist/umd'),
    clean: false, // keep the main bundle: this config only emits its own file
    library: {
      name: 'UtuaSession',
      type: 'umd',
      export: 'default',
    },
  },
  target: ['web', 'es2017'],
  node: {
    global: false,
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: [
          {
            loader: 'ts-loader',
            options: {
              configFile: 'tsconfig.build.json',
              transpileOnly: true,
            },
          },
        ],
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  optimization: {
    moduleIds: 'deterministic',
    minimize: isProd,
    minimizer: isProd
      ? [
          new TerserPlugin({
            extractComments: false,
            terserOptions: {
              ecma: 2017,
              mangle: true,
              compress: true,
              output: {
                comments: false,
              },
            },
          }),
        ]
      : [],
  },
  plugins: [
    new webpack.EnvironmentPlugin({
      IS_WEBPACK_BUILD: true,
    }),
    new CircularDependencyPlugin({
      failOnError: true,
    }),
    ...(isProd ? [new CompressionPlugin({})] : []),
  ],
}

module.exports = config
