import * as React from 'react'
import { json, redirect, type DataFunctionArgs } from '@remix-run/node'
import {
	Form,
	Link,
	useFetcher,
	useLoaderData,
	useSearchParams,
	useSubmit,
} from '@remix-run/react'
import { getAllInstances, getInstanceInfo } from 'litefs-js'
import { ensureInstance } from 'litefs-js/remix.js'
import invariant from 'tiny-invariant'
import { Spacer } from '~/components/spacer.tsx'
import { Button } from '~/components/ui/button.tsx'
import {
	cache,
	getAllCacheKeys,
	lruCache,
	searchCacheKeys,
} from '~/utils/cache.server.ts'
import { Field } from '~/components/forms.tsx'
import { requireAdmin } from '~/utils/permissions.server.ts'

export async function loader({ request }: DataFunctionArgs) {
	await requireAdmin(request)
	const searchParams = new URL(request.url).searchParams
	const query = searchParams.get('query')
	if (query === '') {
		searchParams.delete('query')
		return redirect(`/admin/cache?${searchParams.toString()}`)
	}
	const limit = Number(searchParams.get('limit') ?? 100)

	const currentInstanceInfo = await getInstanceInfo()
	const instance =
		searchParams.get('instance') ?? currentInstanceInfo.currentInstance
	const instances = await getAllInstances()
	await ensureInstance(instance)

	let cacheKeys: { sqlite: Array<string>; lru: Array<string> }
	if (typeof query === 'string') {
		cacheKeys = await searchCacheKeys(query, limit)
	} else {
		cacheKeys = await getAllCacheKeys(limit)
	}
	return json({ cacheKeys, instance, instances, currentInstanceInfo })
}

export async function action({ request }: DataFunctionArgs) {
	await requireAdmin(request)
	const formData = await request.formData()
	const key = formData.get('cacheKey')
	const { currentInstance } = await getInstanceInfo()
	const instance = formData.get('instance') ?? currentInstance
	const type = formData.get('type')

	invariant(typeof key === 'string', 'cacheKey must be a string')
	invariant(typeof type === 'string', 'type must be a string')
	invariant(typeof instance === 'string', 'instance must be a string')
	await ensureInstance(instance)

	switch (type) {
		case 'sqlite': {
			await cache.delete(key)
			break
		}
		case 'lru': {
			lruCache.delete(key)
			break
		}
		default: {
			throw new Error(`Unknown cache type: ${type}`)
		}
	}
	return json({ success: true })
}

export default function CacheAdminRoute() {
	const data = useLoaderData<typeof loader>()
	const [searchParams] = useSearchParams()
	const submit = useSubmit()
	const query = searchParams.get('query') ?? ''
	const limit = searchParams.get('limit') ?? '100'
	const instance = searchParams.get('instance') ?? data.instance

	const handleFormChange = useDebounce((form: HTMLFormElement) => {
		submit(form)
	}, 400)

	return (
		<div className="container">
			<h1 className="text-h1">Cache Admin</h1>
			<Spacer size="2xs" />
			<Form
				method="get"
				className="flex flex-col gap-4"
				onChange={e => handleFormChange(e.currentTarget)}
			>
				<div className="flex-1">
					<div className="flex flex-1 gap-4">
						<button
							type="submit"
							className="flex h-16 items-center justify-center"
						>
							🔎
						</button>
						<Field
							className="flex-1"
							labelProps={{ children: 'Search' }}
							inputProps={{
								type: 'search',
								name: 'query',
								defaultValue: query,
							}}
						/>
						<div className="flex h-16 w-14 items-center text-lg font-medium text-muted-foreground">
							<span title="Total results shown">
								{data.cacheKeys.sqlite.length + data.cacheKeys.lru.length}
							</span>
						</div>
					</div>
				</div>
				<div className="flex flex-wrap items-center gap-4">
					<Field
						labelProps={{
							children: 'Limit',
						}}
						inputProps={{
							name: 'limit',
							defaultValue: limit,
							type: 'number',
							step: '1',
							min: '1',
							max: '10000',
							placeholder: 'results limit',
						}}
					/>
					<select name="instance" defaultValue={instance}>
						{Object.entries(data.instances).map(([inst, region]) => (
							<option key={inst} value={inst}>
								{[
									inst,
									`(${region})`,
									inst === data.currentInstanceInfo.currentInstance
										? '(current)'
										: '',
									inst === data.currentInstanceInfo.primaryInstance
										? ' (primary)'
										: '',
								]
									.filter(Boolean)
									.join(' ')}
							</option>
						))}
					</select>
				</div>
			</Form>
			<Spacer size="2xs" />
			<div className="flex flex-col gap-4">
				<h2 className="text-h2">LRU Cache:</h2>
				{data.cacheKeys.lru.map(key => (
					<CacheKeyRow
						key={key}
						cacheKey={key}
						instance={instance}
						type="lru"
					/>
				))}
			</div>
			<Spacer size="3xs" />
			<div className="flex flex-col gap-4">
				<h2 className="text-h2">SQLite Cache:</h2>
				{data.cacheKeys.sqlite.map(key => (
					<CacheKeyRow
						key={key}
						cacheKey={key}
						instance={instance}
						type="sqlite"
					/>
				))}
			</div>
		</div>
	)
}

function CacheKeyRow({
	cacheKey,
	instance,
	type,
}: {
	cacheKey: string
	instance?: string
	type: 'sqlite' | 'lru'
}) {
	const fetcher = useFetcher<typeof action>()
	const dc = useDoubleCheck()
	const encodedKey = encodeURIComponent(cacheKey)
	const valuePage = `/admin/cache/${type}/${encodedKey}?instance=${instance}`
	return (
		<div className="flex items-center gap-2 font-mono">
			<fetcher.Form method="post">
				<input type="hidden" name="cacheKey" value={cacheKey} />
				<input type="hidden" name="instance" value={instance} />
				<input type="hidden" name="type" value={type} />
				<Button
					size="sm"
					variant="secondary"
					{...dc.getButtonProps({ type: 'submit' })}
				>
					{fetcher.state === 'idle'
						? dc.doubleCheck
							? 'You sure?'
							: 'Delete'
						: 'Deleting...'}
				</Button>
			</fetcher.Form>
			<Link reloadDocument to={valuePage}>
				{cacheKey}
			</Link>
		</div>
	)
}

function callAll<Args extends Array<unknown>>(
	...fns: Array<((...args: Args) => unknown) | undefined>
) {
	return (...args: Args) => fns.forEach(fn => fn?.(...args))
}

export function useDoubleCheck() {
	const [doubleCheck, setDoubleCheck] = React.useState(false)

	function getButtonProps(
		props?: React.ButtonHTMLAttributes<HTMLButtonElement>,
	) {
		const onBlur: React.ButtonHTMLAttributes<HTMLButtonElement>['onBlur'] =
			() => setDoubleCheck(false)

		const onClick: React.ButtonHTMLAttributes<HTMLButtonElement>['onClick'] =
			doubleCheck
				? undefined
				: e => {
						e.preventDefault()
						setDoubleCheck(true)
				  }

		return {
			...props,
			onBlur: callAll(onBlur, props?.onBlur),
			onClick: callAll(onClick, props?.onClick),
		}
	}

	return { doubleCheck, getButtonProps }
}

function debounce<Callback extends (...args: Parameters<Callback>) => void>(
	fn: Callback,
	delay: number,
) {
	let timer: ReturnType<typeof setTimeout> | null = null
	return (...args: Parameters<Callback>) => {
		if (timer) clearTimeout(timer)
		timer = setTimeout(() => {
			fn(...args)
		}, delay)
	}
}

export function useDebounce<
	Callback extends (...args: Parameters<Callback>) => ReturnType<Callback>,
>(callback: Callback, delay: number) {
	const callbackRef = React.useRef(callback)
	React.useEffect(() => {
		callbackRef.current = callback
	})
	return React.useMemo(
		() =>
			debounce(
				(...args: Parameters<Callback>) => callbackRef.current(...args),
				delay,
			),
		[delay],
	)
}

export function ErrorBoundary({ error }: { error: Error }) {
	console.error(error)

	return <div>An unexpected error occurred: {error.message}</div>
}
