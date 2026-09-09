import {APP_ACTIONS} from "../state/appStore.js";
import {friendlyGlobalError} from "../utils/friendlyErrors.js";

export function createAdminController({state, render, dispatch = () => {}}) {
  async function loadAdminUsers({cursor = "", cursorStack = []} = {}) {
    state.admin.loading = true;
    state.admin.error = "";
    render();
    try {
      const data = await state.api.getAdminUsers({
        cursor,
        pageSize: state.admin.pageSize,
      });
      state.admin = {
        ...state.admin,
        users: data.users || [],
        cursor,
        cursorStack,
        nextCursor: data.nextCursor || "",
        allowList: data.allowList || null,
        loading: false,
        error: "",
      };
    } catch (error) {
      state.admin.loading = false;
      state.admin.error = friendlyGlobalError(error);
    }
    render();
  }

  async function showAdmin() {
    if (state.profile?.isAdmin !== true) return;
    dispatch({type: APP_ACTIONS.SET_ACTIVE_PAGE, page: "admin"});
    await loadAdminUsers({cursor: "", cursorStack: []});
  }

  async function refreshAdminUsers() {
    await loadAdminUsers({cursor: state.admin.cursor, cursorStack: state.admin.cursorStack});
  }

  async function nextAdminUsersPage() {
    if (!state.admin.nextCursor) return;
    await loadAdminUsers({
      cursor: state.admin.nextCursor,
      cursorStack: [...state.admin.cursorStack, state.admin.cursor],
    });
  }

  async function previousAdminUsersPage() {
    const cursorStack = [...state.admin.cursorStack];
    const previousCursor = cursorStack.pop();
    if (previousCursor === undefined) return;
    await loadAdminUsers({cursor: previousCursor, cursorStack});
  }

  async function setAdminUserWhitelisted(uid, whitelisted) {
    state.admin.loading = true;
    state.admin.error = "";
    render();
    try {
      const data = await state.api.setAdminUserWhitelisted(uid, whitelisted);
      const updatedUser = data.user;
      state.admin.users = state.admin.users.map((user) => (
        user.uid === uid && updatedUser ? updatedUser : user
      ));
    } catch (error) {
      state.admin.error = friendlyGlobalError(error);
    } finally {
      state.admin.loading = false;
      render();
    }
  }

  return {
    loadAdminUsers,
    nextAdminUsersPage,
    previousAdminUsersPage,
    refreshAdminUsers,
    setAdminUserWhitelisted,
    showAdmin,
  };
}
