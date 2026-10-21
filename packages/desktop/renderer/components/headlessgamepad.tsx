import React from 'react'
import InputControls from './inputcontrols'
export { gamepadState } from '../../shared/console-input'

export default function HeadlessGamepad() {
    return <InputControls headless />
}
