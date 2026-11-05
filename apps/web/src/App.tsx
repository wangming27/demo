import { Navigate, Route, Routes } from 'react-router';
import SessionFeedback from './components/session/SessionFeedback';
import useSession from './hooks/useSession';
import LoginPage from './pages/login/LoginPage';
import NotFoundPage from './pages/not-found/NotFoundPage';
import UsersPage from './pages/users/UsersPage';

export default function App() {
  const account = useSession();
  const { session } = account;

  if (session.status === 'loading' || session.status === 'error') {
    return <SessionFeedback state={session} onRetry={account.retry} />;
  }

  return (
    <Routes>
      <Route
        path="/"
        element={<Navigate to={session.status === 'authenticated' ? '/users' : '/login'} replace />}
      />
      <Route
        path="/login"
        element={
          session.status === 'authenticated' ? (
            <Navigate to="/users" replace />
          ) : (
            <LoginPage notice={session.notice} onAuthenticated={account.authenticated} />
          )
        }
      />
      <Route
        path="/users"
        element={
          session.status === 'authenticated' ? (
            <UsersPage
              user={session.user}
              pending={account.pending}
              error={account.error}
              onRefresh={account.refresh}
              onLogout={account.logout}
              onSessionExpired={account.sessionExpired}
              onUserChanged={account.userChanged}
            />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
