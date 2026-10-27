import {useState} from 'react'
import {expect, test, vi} from 'vitest'
import {render, screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {ApiError} from '../api'
import {Button, ErrorBox, Field, Input, MultiSelect} from './ui'

test('Field labels its control and links the hint as its description', () => {
	render(<Field label="Email" hint="We never share it.">{(id, d) => <Input id={id} aria-describedby={d} />}</Field>)
	expect(screen.getByLabelText('Email')).toHaveAccessibleDescription('We never share it.')
})

const Sectors = ({initial, max}: {initial: string[], max?: number}) => {
	const [value, setValue] = useState(initial)
	return <MultiSelect label="Sectors" options={['Fintech', 'Medtech', 'Agritech']} value={value} onChange={setValue} max={max} />
}

test('MultiSelect stops adding at the maximum but still allows removing', async () => {
	const user = userEvent.setup()
	render(<Sectors initial={['Fintech', 'Medtech']} max={2} />)
	expect(screen.getByRole('checkbox', {name: 'Agritech'})).toBeDisabled()
	await user.click(screen.getByRole('checkbox', {name: 'Fintech'}))
	expect(screen.getByRole('checkbox', {name: 'Fintech'})).not.toBeChecked()
	expect(screen.getByRole('checkbox', {name: 'Agritech'})).toBeEnabled()
})

test('MultiSelect keeps a saved value that is no longer an option', () => {
	render(<Sectors initial={['Robotics']} />)
	const boxes = screen.getAllByRole('checkbox')
	expect(boxes[0]).toHaveAccessibleName('Robotics')
	expect(boxes[0]).toBeChecked()
})

test('ErrorBox shows the API message and offers a retry', async () => {
	const onRetry = vi.fn()
	render(<ErrorBox error={new ApiError(409, 'conflict', 'That name is taken.')} onRetry={onRetry} />)
	expect(screen.getByRole('alert')).toHaveTextContent('That name is taken.')
	await userEvent.click(screen.getByRole('button', {name: 'Try again'}))
	expect(onRetry).toHaveBeenCalledOnce()
})

test('ErrorBox never shows an unexpected error\'s own message', () => {
	render(<ErrorBox error={new Error('TypeError: x is undefined')} />)
	expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong. Please try again.')
})

test('a busy Button is disabled and says so', () => {
	render(<Button busy>Save</Button>)
	expect(screen.getByRole('button', {name: 'Save'})).toBeDisabled()
	expect(screen.getByRole('button', {name: 'Save'})).toHaveAttribute('aria-busy', 'true')
})
