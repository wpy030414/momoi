import { PromptEngine } from './engine.js'

/**
 * 全局唯一的提示词规则引擎实例。
 *
 * 单独成模块（而不是放进 registry.ts）是为了打断循环依赖：
 * 各 fragments 模块可以自由 import 本实例来构建自己的组装入口，
 * 而 registry.ts 负责把内置片段注册进这个实例。
 */
export const promptEngine = new PromptEngine()
