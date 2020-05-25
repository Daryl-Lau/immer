import {
	ImmerState,
	Drafted,
	ES5ArrayState,
	ES5ObjectState,
	each,
	has,
	isDraft,
	isDraftable,
	shallowCopy,
	latest,
	DRAFT_STATE,
	is,
	loadPlugin,
	ImmerScope,
	createProxy,
	ProxyTypeES5Array,
	ProxyTypeES5Object,
	AnyObject,
	getCurrentScope,
	die
} from "../internal"

type ES5State = ES5ArrayState | ES5ObjectState

export function enableES5() {
	function willFinalizeES5_(
		scope: ImmerScope,
		result: any,
		isReplaced: boolean
	) {
		scope.drafts_!.forEach((draft: any) => {
			;(draft[DRAFT_STATE] as ES5State).finalizing_ = true
		})
		if (!isReplaced) {
			if (scope.patches_) {
				markChangesRecursively(scope.drafts_![0])
			}
			// This is faster when we don't care about which attributes changed.
			markChangesSweep(scope.drafts_)
		}
		// When a child draft is returned, look for changes.
		else if (
			isDraft(result) &&
			(result[DRAFT_STATE] as ES5State).scope_ === scope
		) {
			markChangesSweep(scope.drafts_)
		}
	}

	function createES5Draft(isArray: boolean, base: any) {
		// Create a new object / array, where each own property is trapped with an accessor
		const descriptors = Object.getOwnPropertyDescriptors(base)
		// Descriptors we want to skip:
		if (isArray) delete descriptors.length
		delete descriptors[DRAFT_STATE as any]
		for (let key in descriptors) {
			descriptors[key] = proxyProperty(
				key,
				isArray || !!descriptors[key].enumerable
			)
		}
		if (isArray) {
			const draft = new Array(base.length)
			Object.defineProperties(draft, descriptors)
			return draft
		} else {
			return Object.create(Object.getPrototypeOf(base), descriptors)
		}
	}

	function createES5Proxy_<T>(
		base: T,
		parent?: ImmerState
	): Drafted<T, ES5ObjectState | ES5ArrayState> {
		const isArray = Array.isArray(base)
		const draft = createES5Draft(isArray, base)

		const state: ES5ObjectState | ES5ArrayState = {
			type_: isArray ? ProxyTypeES5Array : (ProxyTypeES5Object as any),
			scope_: parent ? parent.scope_ : getCurrentScope(),
			modified_: false,
			finalizing_: false,
			finalized_: false,
			assigned_: {},
			parent_: parent,
			// base is the object we are drafting
			base_: base,
			// draft is the draft object itself, that traps all reads and reads from either the base (if unmodified) or copy (if modified)
			draft_: draft,
			copy_: null,
			revoked_: false,
			isManual_: false
		}

		Object.defineProperty(draft, DRAFT_STATE, {
			value: state,
			// enumerable: false <- the default
			writable: true
		})
		return draft
	}

	// Access a property without creating an Immer draft.
	function peek(draft: Drafted, prop: PropertyKey) {
		const state: ES5State = draft[DRAFT_STATE]
		if (state && !state.finalizing_) {
			// state.finalizing_ = true // TODO: still needed?
			// If not, delete this block!
			const value = draft[prop]
			// state.finalizing_ = false
			return value
		}
		return draft[prop]
	}

	function get(state: ES5State, prop: string | number) {
		assertUnrevoked(state)
		const value = peek(latest(state), prop)
		if (state.finalizing_) return value
		// Create a draft if the value is unmodified.
		if (value === peek(state.base_, prop) && isDraftable(value)) {
			prepareCopy(state)
			// @ts-ignore
			return (state.copy_![prop] = createProxy(
				state.scope_.immer_,
				value,
				state
			))
		}
		return value
	}

	function set(state: ES5State, prop: string | number, value: any) {
		assertUnrevoked(state)
		state.assigned_[prop] = true
		if (!state.modified_) {
			if (is(value, peek(latest(state), prop))) return
			markChangedES5_(state)
			prepareCopy(state)
		}
		// @ts-ignore
		state.copy_![prop] = value
	}

	function markChangedES5_(state: ImmerState) {
		if (!state.modified_) {
			state.modified_ = true
			if (state.parent_) markChangedES5_(state.parent_)
		}
	}

	function prepareCopy(state: ES5State) {
		if (state.copy_) return
		const stateofBase: ES5State | undefined = (state.base_ as any)[DRAFT_STATE]

		// make a copy, if the base is a draft itself, we take a copy of it's current state
		// stateofBase?.finalizing_ = true; // TODO: needed?

		// TODO: some code reuse?
		// Object.getOwnPropertyDescriptors
		state.copy_ = shallowCopy(state.base_, true)
		// stateofBase?.finalizing_ = false; // TODO: needed?
	}

	function createFinalCopy_(state: ES5ArrayState | ES5ObjectState): any {
		state.finalizing_ = true
		const res = shallowCopy(state.draft_, true)
		state.finalizing_ = false
		return res

		if (state.type_ === ProxyTypeES5Array) return state.draft_?.slice()
		// We create a final copy, based on the keys present in the draft.
		// However, since most draft keys are wrapped getters, so lets take the descriptor of the copy
		// so that any getters can be preserved (if present)
		const final = Object.create(Object.getPrototypeOf(state.draft_))
		// TODO: extract utils for getPrototypeOf / getOwnPropertyDescriptors
		const draftDescriptors = Object.getOwnPropertyDescriptors(state.draft_)
		// const copyDescriptors = Object.getOwnPropertyDescriptors(latest(state))
		for (let key in draftDescriptors) {
			// @ts-ignore
			if (key === DRAFT_STATE) return
			const desc = draftDescriptors[key]
			// if there is a value in the descriptor, it was deleted and readded, so respect the draft one
			Object.defineProperty(final, key, {
				writable: true,
				enumerable: desc.enumerable,
				configurable: true,
				value: state.draft_[key]
			})
		}
		return final
	}

	// property descriptors are recycled to make sure we don't create a get and set closure per property,
	// but share them all instead
	const descriptors: {[prop: string]: PropertyDescriptor} = {}

	function proxyProperty(
		prop: string | number,
		enumerable: boolean
	): PropertyDescriptor {
		let desc = descriptors[prop]
		if (desc) {
			desc.enumerable = enumerable
		} else {
			descriptors[prop] = desc = {
				configurable: true,
				enumerable,
				get(this: any) {
					return get(this[DRAFT_STATE], prop)
				},
				set(this: any, value) {
					set(this[DRAFT_STATE], prop, value)
				}
			}
		}
		return desc
	}

	// This looks expensive, but only proxies are visited, and only objects without known changes are scanned.
	function markChangesSweep(drafts: Drafted<any, ImmerState>[]) {
		// The natural order of drafts in the `scope` array is based on when they
		// were accessed. By processing drafts in reverse natural order, we have a
		// better chance of processing leaf nodes first. When a leaf node is known to
		// have changed, we can avoid any traversal of its ancestor nodes.
		for (let i = drafts.length - 1; i >= 0; i--) {
			const state: ES5State = drafts[i][DRAFT_STATE]
			if (!state.modified_) {
				switch (state.type_) {
					case ProxyTypeES5Array:
						if (hasArrayChanges(state)) markChangedES5_(state)
						break
					case ProxyTypeES5Object:
						if (hasObjectChanges(state)) markChangedES5_(state)
						break
				}
			}
		}
	}

	function markChangesRecursively(object: any) {
		if (!object || typeof object !== "object") return
		const state: ES5State | undefined = object[DRAFT_STATE]
		if (!state) return
		const {base_, draft_, assigned_, type_} = state
		if (type_ === ProxyTypeES5Object) {
			// Look for added keys.
			// TODO: looks quite duplicate to hasObjectChanges,
			// probably there is a faster way to detect changes, as sweep + recurse seems to do some
			// unnecessary work.
			// also: probably we can store the information we detect here, to speed up tree finalization!
			each(draft_, key => {
				if ((key as any) === DRAFT_STATE) return
				// The `undefined` check is a fast path for pre-existing keys.
				if ((base_ as any)[key] === undefined && !has(base_, key)) {
					assigned_[key] = true
					markChangedES5_(state)
				} else if (!assigned_[key]) {
					// Only untouched properties trigger recursion.
					markChangesRecursively(draft_[key])
				}
			})
			// Look for removed keys.
			each(base_, key => {
				// The `undefined` check is a fast path for pre-existing keys.
				if (draft_[key] === undefined && !has(draft_, key)) {
					assigned_[key] = false
					markChangedES5_(state)
				}
			})
		} else if (type_ === ProxyTypeES5Array) {
			if (hasArrayChanges(state as ES5ArrayState)) {
				markChangedES5_(state)
				assigned_.length = true
			}

			if (draft_.length < base_.length) {
				for (let i = draft_.length; i < base_.length; i++) assigned_[i] = false
			} else {
				for (let i = base_.length; i < draft_.length; i++) assigned_[i] = true
			}

			// Minimum count is enough, the other parts has been processed.
			const min = Math.min(draft_.length, base_.length)

			for (let i = 0; i < min; i++) {
				// Only untouched indices trigger recursion.
				if (assigned_[i] === undefined) markChangesRecursively(draft_[i])
			}
		}
	}

	function hasObjectChanges(state: ES5ObjectState) {
		const {base_, draft_} = state

		// Search for added keys and changed keys. Start at the back, because
		// non-numeric keys are ordered by time of definition on the object.
		const keys = Object.keys(draft_)
		for (let i = keys.length - 1; i >= 0; i--) {
			const key = keys[i]
			const baseValue = base_[key]
			// The `undefined` check is a fast path for pre-existing keys.
			if (baseValue === undefined && !has(base_, key)) {
				return true
			}
			// Once a base key is deleted, future changes go undetected, because its
			// descriptor is erased. This branch detects any missed changes.
			else {
				const value = draft_[key]
				const state: ImmerState = value && value[DRAFT_STATE]
				if (state ? state.base_ !== baseValue : !is(value, baseValue)) {
					return true
				}
			}
		}

		// At this point, no keys were added or changed.
		// Compare key count to determine if keys were deleted.
		return keys.length !== Object.keys(base_).length
	}

	function hasArrayChanges(state: ES5ArrayState) {
		const {draft_} = state
		if (draft_.length !== state.base_.length) return true
		// See #116
		// If we first shorten the length, our array interceptors will be removed.
		// If after that new items are added, result in the same original length,
		// those last items will have no intercepting property.
		// So if there is no own descriptor on the last position, we know that items were removed and added
		// N.B.: splice, unshift, etc only shift values around, but not prop descriptors, so we only have to check
		// the last one
		const descriptor = Object.getOwnPropertyDescriptor(
			draft_,
			draft_.length - 1
		)
		// descriptor can be null, but only for newly created sparse arrays, eg. new Array(10)
		if (descriptor && !descriptor.get) return true
		// For all other cases, we don't have to compare, as they would have been picked up by the index setters
		return false
	}

	/*#__PURE__*/
	function isEnumerable(base: AnyObject, prop: PropertyKey): boolean {
		const desc = Object.getOwnPropertyDescriptor(base, prop)
		return desc && desc.enumerable ? true : false
	}

	function assertUnrevoked(state: any /*ES5State | MapState | SetState*/) {
		if (state.revoked_) die(3, JSON.stringify(latest(state)))
	}

	loadPlugin("ES5", {
		createES5Proxy_,
		markChangedES5_,
		willFinalizeES5_,
		createFinalCopy_
	})
}
