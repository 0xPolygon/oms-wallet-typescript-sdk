import type {BrandedProvider} from './public.js'

export type AutomaticSelection<T extends {walletSelection?: 'automatic' | 'manual'}> =
    Omit<T, 'walletSelection'> & {walletSelection?: 'automatic'}

export type ManualSelection<T extends {walletSelection?: 'automatic' | 'manual'}> =
    Omit<T, 'walletSelection'> & {walletSelection: 'manual'}

export interface ConstructorParams<T> {
    value: T
    provider: BrandedProvider
}

export interface ErrorParams<Code extends string = string> {
    code: Code
    message: string
    cause?: unknown
}

export type PrivateErrorCode = 'FIXTURE_ONE' | 'FIXTURE_TWO'
