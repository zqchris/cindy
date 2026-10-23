import { useEffect, useState } from 'react';
import { Alert, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { SimpleStackHeader, simpleScreenSafeAreaEdges } from '@/platform/chrome/SimpleStackHeader';
import { useThemedStyles } from '@/theme';
import { ModelsPanel } from './ModelsPanel';
import { providers, type Provider } from './providers';
import { nativeHarness } from './kernel';
import { harnessStyles } from './styles';
export default function ModelSettingsScreen() {
  const auth = useAuth();
  return <ModelSettings key={auth.accountGeneration} />;
}
function ModelSettings() {
  const router = useRouter(); const { t } = useTranslation(); const styles = useThemedStyles(harnessStyles);
  const [all, setAll] = useState<Provider[]>([]); const [availability, setAvailability] = useState('unavailable');
  const report = (error: unknown) => Alert.alert(t('session.local.models'), error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : t('session.local.failed'));
  useEffect(() => { let active = true;
    void providers().then(p => { if (active) setAll(p); }).catch(report);
    void nativeHarness?.localModelAvailability().then(a => { if (active) setAvailability(a); });
    return () => { active = false; };
  }, []);
  return <SafeAreaView edges={simpleScreenSafeAreaEdges()} style={styles.root}>
    <SimpleStackHeader title={t('session.local.models')} onBack={() => router.back()} />
    <View style={{ flex: 1 }}><ModelsPanel allProviders={all} selected="" availability={availability}
      onSelect={() => {}} onProvidersChange={setAll} onDone={() => {}} report={report} /></View>
  </SafeAreaView>;
}
